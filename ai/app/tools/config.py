"""Limits for tool orchestration. Defaults equal Node's defaults; Python may be stricter, never needs to be looser."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Mapping
from urllib.parse import urlsplit

from ..core.config import ConfigError, _int


@dataclass(frozen=True)
class ToolSettings:
    node_url: str = "http://127.0.0.1:5002"  # the ONLY place a callback can go (never taken from a request or from the model)
    max_rounds: int = 3  # model calls that may ask for tools; one more call (without tools) writes the final answer
    max_calls: int = 5  # tool calls per request, valid or not
    max_concurrent: int = 2
    call_timeout_ms: int = 8_000  # Node's per-tool limit
    call_grace_ms: int = 1_500  # network + Node overhead on top of it
    connect_timeout_ms: int = 2_000
    total_tool_ms: int = 20_000  # summed tool time per request (Node's budget)
    deadline_ms: int = 110_000  # whole tool-enabled request; Node's ceiling is 120 s
    max_result_bytes: int = 8_192
    max_argument_chars: int = 1_024
    max_response_bytes: int = 32_768  # what we will even read from Node
    keepalive_ms: int = 10_000  # while a Groq call is in flight (answers are buffered, so nothing else is sent): one SSE comment this often


    def check(self) -> "ToolSettings":
        """Refuses a set of limits that cannot work (fail closed at startup rather than misbehave under load)."""
        ok = (
            self.max_concurrent <= self.max_calls and self.call_timeout_ms <= self.total_tool_ms
            and self.call_timeout_ms + self.call_grace_ms + self.connect_timeout_ms < self.deadline_ms
            and self.total_tool_ms < self.deadline_ms and self.max_result_bytes <= self.max_response_bytes
        )
        if not ok:
            raise ConfigError("the AI_TOOL_* limits are inconsistent")
        return self

    def bounded_by(self, node) -> "ToolSettings":
        """The limits for ONE request: Node's (from the signed token) or this process's own, whichever is STRICTER. Python can never
        exceed Node; a Node limit that leaves no room to work refuses the request (ValueError) instead of running with less safety."""
        deadline = min(self.deadline_ms, node.ceiling_ms - 10_000)  # finish before Node's own ceiling aborts us
        limits = replace(
            self, max_rounds=min(self.max_rounds, node.rounds), max_calls=min(self.max_calls, node.calls), max_concurrent=min(self.max_concurrent, node.concurrent),
            call_timeout_ms=min(self.call_timeout_ms, node.call_ms), total_tool_ms=min(self.total_tool_ms, node.total_ms),
            max_result_bytes=min(self.max_result_bytes, node.result_bytes), deadline_ms=deadline,
        )
        try:
            return limits.check()
        except ConfigError:
            raise ValueError("tool limits incompatible") from None


def load_tool_settings(env: Mapping[str, str]) -> ToolSettings:
    url = (env.get("AI_NODE_INTERNAL_URL", "").strip() or "http://127.0.0.1:5002").rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in {"", "/"}:
        raise ConfigError("AI_NODE_INTERNAL_URL must be a plain http(s) origin")
    return ToolSettings(
        node_url=url,
        max_rounds=_int(env, "AI_TOOL_MAX_ROUNDS", 3, maximum=6),
        max_calls=_int(env, "AI_TOOL_MAX_CALLS", 5, maximum=20),
        max_concurrent=_int(env, "AI_TOOL_MAX_CONCURRENT", 2, maximum=4),
        call_timeout_ms=_int(env, "AI_TOOL_TIMEOUT_MS", 8_000, maximum=30_000),
        total_tool_ms=_int(env, "AI_TOOL_TOTAL_MS", 20_000, maximum=60_000),
        max_result_bytes=_int(env, "AI_TOOL_MAX_RESULT_BYTES", 8_192, maximum=65_536),
        keepalive_ms=_int(env, "AI_TOOL_KEEPALIVE_MS", 10_000, minimum=100, maximum=20_000),
    ).check()
