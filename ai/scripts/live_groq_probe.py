"""LIVE Groq verification of the tool loop (Phase 8 Step 6A). NOT part of the test suite: run it by hand.

    cd ai && .venv/bin/python scripts/live_groq_probe.py

 * Reads GROQ_API_KEY from the gitignored ai/.env. The key is never printed, logged or put in a result.
 * Real Groq, FAKE Node: tool callbacks are answered with small deterministic data. No organizational data, no Node.
 * Bounded: about a dozen requests, small outputs, NO retries (max_retries=0), and it stops at the first rate-limit/auth error.
 * Output: scenario, model, outcome, rounds, calls, latency, tokens. Answers are not printed (only whether a known number appears).
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core import errors as E  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.core.errors import ProviderError  # noqa: E402
from app.orchestration.tool_loop import tool_frames  # noqa: E402
from app.providers.groq import GroqProvider  # noqa: E402
from app.schemas.generate import GenerateRequest  # noqa: E402
from app.tools.config import ToolSettings  # noqa: E402
from app.tools.definitions import model_tools  # noqa: E402
from tests.tool_support import FakeNode  # noqa: E402


class ThrottledGroq(GroqProvider):
    """One real Groq call at most every GAP seconds: the key has per-minute token limits, and each call reads ~1.7k tokens of tool definitions."""

    GAP = 25.0
    _last = 0.0

    async def chat(self, **kw):
        wait = self.GAP - (time.monotonic() - self._last)
        if wait > 0 and self._last:
            await asyncio.sleep(wait)
        try:
            async for event in super().chat(**kw):
                yield event
        finally:
            self._last = time.monotonic()


MAX_OUT = 450


def load_key() -> str:
    path = ROOT / ".env"
    if not path.exists():
        return ""
    for line in path.read_text().splitlines():
        if line.startswith("GROQ_API_KEY="):
            return line.split("=", 1)[1].strip()
    return ""


def fake_result(body: dict) -> tuple[int, dict]:
    name, args = body["name"], body["arguments"]
    data: dict
    if name == "list_projects":
        data = {"data": [{"name": "Apollo", "status": "Active", "openTasks": 4, "overdueTasks": 1}, {"name": "Zephyr", "status": "Planning", "openTasks": 2, "overdueTasks": 0}, {"name": "Gemini", "status": "Active", "openTasks": 7, "overdueTasks": 2}], "summary": {"count": 3, "total": 3, "truncated": False, "complete": True}}
    elif name == "get_project_overview":
        data = {"outcome": "found", "project": {"name": "Apollo", "status": "Active", "openTasks": 4, "overdueTasks": 1, "memberCount": 5}}
    elif name == "list_project_tasks":
        data = {"data": [{"title": "Write spec", "status": "In Progress", "dueDate": "2026-11-20"}, {"title": "Review budget", "status": "Todo", "dueDate": "2026-11-18"}], "summary": {"count": 2, "total": 2, "truncated": False, "complete": True}}
    elif name == "get_team":
        data = {"outcome": "list", "teams": [{"name": "Platform", "memberCount": 6}], "summary": {"count": 1, "total": 1, "truncated": False, "complete": True}}
    elif name == "list_my_tasks":
        data = {"data": [{"title": "Fix login bug", "status": "In Progress", "dueDate": "2026-11-16"}, {"title": "Update docs", "status": "Todo", "dueDate": "2026-11-25"}], "summary": {"count": 2, "total": 2, "truncated": False, "complete": True}}
    else:
        data = {"data": [], "summary": {"count": 0, "total": 0, "truncated": False, "complete": True}}
    return 200, {"success": True, "callId": body["callId"], "result": data}


SYSTEM = "You are the Sync OS assistant for a company workspace. Be brief. Use the tools only when the question needs live workspace data."


async def run_scenario(provider, node: FakeNode, settings: Settings, label: str, question: str, expect: str | None, *, tools_cfg=None):
    node.requests.clear()
    node.bodies.clear()
    body = GenerateRequest.model_validate({"purpose": "chat", "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]})
    frames, started = [], time.monotonic()
    async for raw in tool_frames(provider=provider, http=node.client(), body=body, tool_token="PROBE-NOT-A-REAL-TOKEN", settings=settings, request_id="probe", max_output_tokens=MAX_OUT, model=settings.model_chat):
        for block in raw.decode().strip().split("\n\n"):
            frames.append(json.loads(block.split("data: ", 1)[1]))
    ms = int((time.monotonic() - started) * 1000)
    kinds = [f["type"] for f in frames]
    usage = next((f for f in frames if f["type"] == "usage"), None)
    text = "".join(f.get("text", "") for f in frames if f["type"] == "text")
    last = frames[-1]
    ok = last["type"] == "done"
    print(json.dumps({
        "scenario": label, "model": settings.model_chat, "outcome": "done" if ok else f"error:{last.get('code')}",
        "frames": kinds, "toolCallbacks": [b["name"] for b in node.bodies], "latencyMs": ms,
        "tokens": {k: usage[k] for k in ("inputTokens", "outputTokens", "totalTokens")} if usage else None,
        "answerChars": len(text), "containsExpected": (expect in text) if expect else None,
    }))
    if last["type"] == "error" and last.get("code") in (E.RATE_LIMITED, E.AUTH):
        raise ProviderError(last["code"])  # stop at once: never hammer a limited key
    return last


async def history_probe(provider, settings, label: str, messages: list[dict], tools=True):
    started = time.monotonic()
    events = []
    try:
        async for e in provider.chat(model=settings.model_chat, messages=messages, tools=model_tools() if tools else None, tool_choice="auto" if tools else None, temperature=0.2, max_output_tokens=MAX_OUT):
            events.append(e["type"])
        outcome = "accepted"
    except ProviderError as error:
        outcome = f"rejected:{error.code}"
        if error.code in (E.RATE_LIMITED, E.AUTH):
            print(json.dumps({"scenario": label, "outcome": outcome}))
            raise
    print(json.dumps({"scenario": label, "model": settings.model_chat, "outcome": outcome, "events": events, "latencyMs": int((time.monotonic() - started) * 1000)}))


PACE_SECONDS = 0  # (the provider below throttles every real call instead)  # Groq's per-minute token limits: each request here reads ~1.7k tokens (the eight tool definitions)


async def main() -> int:
    only = {a for a in sys.argv[1:]}  # e.g. `3 4` runs only those scenarios; default: all
    key = load_key()
    if not key:
        print("NO KEY: ai/.env has no GROQ_API_KEY; live tests not run")
        return 2
    settings = Settings(groq_api_key=key, max_retries=0, request_timeout_ms=60_000, first_byte_timeout_ms=30_000, stream_idle_timeout_ms=30_000, max_output_tokens=MAX_OUT, tools=ToolSettings())
    provider = ThrottledGroq(settings)
    node = FakeNode()
    node.responder = fake_result
    try:
        print(json.dumps({"configuredModel": settings.model_chat, "tools": len(model_tools())}))
        first = True

        async def pace():
            nonlocal first
            if not first:
                await asyncio.sleep(PACE_SECONDS)
            first = False

        def wanted(n):
            return not only or n in only

        if wanted("1"):
            await pace()
            await run_scenario(provider, node, settings, "1 plain answer (tools offered, none needed)", "Say hello in exactly five words.", None)
        if wanted("2"):
            await pace()
            await run_scenario(provider, node, settings, "2 one tool call then answer", "How many projects can I see right now? Use the tools.", "3")
        if wanted("3"):
            await pace()
            await run_scenario(provider, node, settings, "3 several calls in one response", "Using the tools, show me my open tasks AND my team details. Call both tools together in the same step.", None)
        if wanted("4"):
            await pace()
            await run_scenario(provider, node, settings, "4 sequential rounds", "Give me an overview of the Apollo project, and then list its tasks.", "Write spec")
        if wanted("5"):
            await pace()
            # a tool that fails: the model must report it did not get the data, not invent it
            node.responder = lambda b: (500, {"success": False, "code": "AI_TOOL_FAILED", "message": "x"})
            await run_scenario(provider, node, settings, "5 tool failure -> honest answer", "How many projects can I see right now? Use the tools.", None)
            node.responder = fake_result
        # 6/7: the history format Python produces for refused calls, and for a provider error after tool calls
        base = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "How many projects can I see?"}]
        refused = base + [
            {"role": "assistant", "content": None, "toolCalls": [{"id": "call_probe_1", "name": "invalid_tool", "arguments": "{}"}]},
            {"role": "tool", "toolCallId": "call_probe_1", "name": "invalid_tool", "content": '{"status":"error","error":"AI_TOOL_NOT_FOUND"}'},
        ]
        bad_args = base + [
            {"role": "assistant", "content": None, "toolCalls": [{"id": "call_probe_2", "name": "list_projects", "arguments": "{}"}]},
            {"role": "tool", "toolCallId": "call_probe_2", "name": "list_projects", "content": '{"status":"error","error":"AI_TOOL_BAD_ARGUMENTS","invalidFields":["limit"]}'},
        ]
        orphan = base + [{"role": "tool", "toolCallId": "call_never_made", "name": "list_projects", "content": '{"status":"ok","result":{}}'}]
        if wanted("6") or wanted("6a"):
            await pace()
            await history_probe(provider, settings, "6a history with a REFUSED unknown tool name (assistant tool call + error tool message)", refused)
            await pace()
            await history_probe(provider, settings, "6b history with a refused call whose arguments were replaced by {}", bad_args)
        if wanted("7"):
            await pace()
            await history_probe(provider, settings, "7 provider error: tool message for a call that was never made", orphan)
    except ProviderError as error:
        print(json.dumps({"stopped": error.code}))
        return 1
    finally:
        await provider.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
