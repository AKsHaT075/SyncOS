"""The ONLY way Python asks Node to run a tool.

 * One fixed URL (configured, never taken from the request or the model): POST {node_url}/internal/ai/tools/execute.
 * The tool token (minted by Node for THIS request, scope tool:execute) goes in the Authorization header and nowhere else:
   not in the prompt, not in any log, not in any result.
 * Redirects are never followed (a 3xx is a failure). Hard connect/read/overall timeouts. At most `max_response_bytes` is read.
 * NEVER retried: after a timeout or a dropped connection the tool may already have run, and a second call could double-spend
   Node's budget (Node would refuse it as a duplicate anyway). The caller gets a failure and tells the model so.
 * Node's reply is validated before anything is used from it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import ToolSettings
from .results import ResultInvalid, sanitize_result

log = logging.getLogger("ai.tools")

_FIELD = re.compile(r"^[A-Za-z0-9_.\[\]]{0,64}$")
# Codes Node may answer with that the MODEL may be told about (nothing else is ever passed on).
MODEL_VISIBLE = {
    "AI_TOOL_BAD_ARGUMENTS", "AI_TOOL_NOT_FOUND", "AI_TOOL_BUDGET", "AI_TOOL_CONCURRENCY", "AI_TOOL_DUPLICATE",
    "AI_TOOL_TIMEOUT", "AI_TOOL_ABORTED", "AI_TOOL_RESULT_TOO_LARGE", "AI_TOOL_RESULT_INVALID", "AI_TOOL_FAILED",
}
UNAVAILABLE = "AI_TOOL_UNAVAILABLE"  # our own: Node could not be reached / answered badly. The tool MAY have run.


@dataclass(frozen=True)
class ToolOutcome:
    kind: str  # "ok" | "error" | "fatal"
    result: dict | None = None
    code: str | None = None
    fields: list[str] = field(default_factory=list)


class NodeToolClient:
    def __init__(self, http: httpx.AsyncClient, settings: ToolSettings, token: str, request_id: str) -> None:
        self._http, self._s, self._token, self._rid = http, settings, token, request_id
        self.sent = 0  # how many callbacks were actually sent (tests assert "no retry")

    async def execute(self, *, call_id: str, name: str, arguments: dict, timeout_s: float) -> ToolOutcome:
        started = time.monotonic()
        outcome = await self._execute(call_id, name, arguments, timeout_s)
        # Names and codes only: never arguments, results, the token, or the question.
        log.info("tool request=%s tool=%s kind=%s code=%s ms=%d", self._rid, name, outcome.kind, outcome.code, (time.monotonic() - started) * 1000)
        return outcome

    async def _execute(self, call_id: str, name: str, arguments: dict, timeout_s: float) -> ToolOutcome:
        s = self._s
        timeout = httpx.Timeout(connect=s.connect_timeout_ms / 1000, read=timeout_s, write=5.0, pool=2.0)
        self.sent += 1
        try:
            async with asyncio.timeout(timeout_s + s.connect_timeout_ms / 1000):
                async with self._http.stream(
                    "POST", f"{s.node_url}/internal/ai/tools/execute",
                    headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json", "Accept": "application/json"},
                    json={"callId": call_id, "name": name, "arguments": arguments},
                    timeout=timeout, follow_redirects=False,
                ) as response:
                    status = response.status_code
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > s.max_response_bytes:
                            return ToolOutcome("error", code=UNAVAILABLE)
        except (asyncio.TimeoutError, httpx.HTTPError):
            return ToolOutcome("error", code=UNAVAILABLE)  # ambiguous: no retry, ever
        return self._interpret(status, bytes(raw), call_id)

    def _interpret(self, status: int, raw: bytes, call_id: str) -> ToolOutcome:
        try:
            body: Any = json.loads(raw)
        except ValueError:
            body = None
        if status in (401, 403):
            return ToolOutcome("fatal", code=f"HTTP_{status}")  # the token, the request or the user's access is gone: stop everything
        if status == 200:
            if not isinstance(body, dict) or set(body) != {"success", "callId", "result"} or body["success"] is not True or body["callId"] != call_id:
                return ToolOutcome("error", code=UNAVAILABLE)
            try:
                return ToolOutcome("ok", result=sanitize_result(body["result"], max_bytes=self._s.max_result_bytes))
            except ResultInvalid:
                return ToolOutcome("error", code="AI_TOOL_RESULT_INVALID")
        if 300 <= status < 400 or not isinstance(body, dict):
            return ToolOutcome("error", code=UNAVAILABLE)
        code = body.get("code")
        if code in {"AI_DISABLED", "AI_LIVE_DATA_DISABLED", "AI_LIVE_TOOLS_PLATFORM_DISABLED", "AI_CALLBACK_UNAUTHORIZED", "AI_CALLBACK_SCOPE"}:
            return ToolOutcome("fatal", code=str(code))
        if code not in MODEL_VISIBLE:
            return ToolOutcome("error", code="AI_TOOL_FAILED")
        fields: list[str] = []
        details = body.get("details")
        if code == "AI_TOOL_BAD_ARGUMENTS" and isinstance(details, dict) and isinstance(details.get("fields"), list):
            fields = [f for f in details["fields"][:10] if isinstance(f, str) and _FIELD.match(f)]
        return ToolOutcome("error", code=code, fields=fields)
