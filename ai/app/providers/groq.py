"""Groq adapter (OpenAI-compatible Chat Completions), LLM inference only.

Port of the Phase 1 Node adapter with identical behaviour:

  chat(model, messages, tools?, tool_choice?, temperature?, max_output_tokens?)
    -> async iterator of normalized events (dicts, camelCase keys = the wire contract)
         {type:'text', text}
         {type:'tool_calls', calls:[{id,name,arguments,input,inputError}]}   once, at the end
         {type:'usage', inputTokens, outputTokens, totalTokens, estimated}
         {type:'done', finishReason, model, provider, requestId, firstEventMs}

Reliability: retries (bounded, jittered, Retry-After honoured) happen ONLY before the first event
is yielded; three timers (first event, idle, whole attempt); cancellation of the consuming task
closes the upstream response; errors are normalized and carry no upstream text or key; a stream
that ends without a finish_reason is treated as truncated. Reasoning deltas are ignored.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import math
import random
import re
import time
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx

from ..core import errors as E
from ..core.config import Settings
from ..core.errors import ProviderError
from .errors import from_http_response
from .sse import iter_sse_data

MAX_TOOLS = 128
TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROVIDER = "groq"


def to_wire_messages(messages: list[dict]) -> list[dict]:
    wire: list[dict] = []
    for m in messages:
        if m["role"] == "assistant" and m.get("toolCalls"):
            entry: dict[str, Any] = {"role": "assistant"}
            if m.get("content"):
                entry["content"] = str(m["content"])
            entry["tool_calls"] = [
                {
                    "id": c["id"],
                    "type": "function",
                    "function": {
                        "name": c["name"],
                        "arguments": c["arguments"] if isinstance(c.get("arguments"), str) else json.dumps(c.get("arguments") or {}),
                    },
                }
                for c in m["toolCalls"]
            ]
            wire.append(entry)
        elif m["role"] == "tool":
            entry = {"role": "tool", "tool_call_id": m.get("toolCallId")}
            if m.get("name"):
                entry["name"] = m["name"]
            entry["content"] = str(m.get("content") or "")
            wire.append(entry)
        else:
            wire.append({"role": m["role"], "content": str(m.get("content") or "")})
    return wire


def to_wire_tools(tools: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description") or "",
                "parameters": t.get("parameters") or {"type": "object", "properties": {}},
            },
        }
        for t in tools
    ]


def parse_tool_input(raw: str) -> tuple[dict | None, bool]:
    if not raw or not raw.strip():
        return {}, False
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None, True
    return (parsed, False) if isinstance(parsed, dict) else (None, True)


def _compact(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class GroqProvider:
    name = PROVIDER

    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.settings = settings
        self._http = http or httpx.AsyncClient(timeout=None)  # we enforce our own three timers
        self._owns_http = http is None
        self._sleep = sleep

    def is_configured(self) -> bool:
        return self.settings.configured

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    # ------------------------------------------------------------------ public

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int | None = None,
        max_retries: int | None = None,
    ) -> AsyncIterator[dict]:
        if not self.is_configured():
            raise ProviderError(E.NOT_CONFIGURED)
        self._validate(model, messages, tools)
        retries = self.settings.max_retries if max_retries is None else max_retries
        started = False
        attempt = 0
        while True:
            try:
                # aclosing: if the consumer stops early, the inner generator (and its socket) closes NOW, not at GC time.
                async with contextlib.aclosing(self._stream_once(model, messages, tools, tool_choice, temperature, max_output_tokens)) as stream:
                    async for event in stream:
                        started = True
                        yield event
                return
            except ProviderError as error:
                error.stream_started = started
                if started or not error.retryable or attempt >= retries:
                    raise
                await self._sleep(self._backoff(attempt, error))
                attempt += 1

    # ----------------------------------------------------------------- helpers

    @staticmethod
    def _validate(model: str, messages: list[dict], tools: list[dict] | None) -> None:
        if not model or not isinstance(model, str) or not messages:
            raise ProviderError(E.BAD_REQUEST)
        if tools and (len(tools) > MAX_TOOLS or any(not TOOL_NAME.match(t.get("name") or "") for t in tools)):
            raise ProviderError(E.BAD_REQUEST)

    def _backoff(self, attempt: int, error: ProviderError) -> float:
        s = self.settings
        if error.retry_after_ms is not None:
            return min(s.retry_after_max_ms, error.retry_after_ms) / 1000
        backoff = min(s.backoff_max_ms, s.backoff_base_ms * 2**attempt)
        return (backoff / 2 + random.random() * (backoff / 2)) / 1000

    async def _stream_once(self, model, messages, tools, tool_choice, temperature, max_output_tokens) -> AsyncIterator[dict]:
        s = self.settings
        loop = asyncio.get_running_loop()
        cap = min(max_output_tokens or s.max_output_tokens, s.max_output_tokens)
        wire_messages = to_wire_messages(messages)
        body: dict[str, Any] = {"model": model, "messages": wire_messages, "stream": True, "temperature": temperature, "max_completion_tokens": cap}
        if tools:
            body["tools"] = to_wire_tools(tools)
            if tool_choice:
                body["tool_choice"] = tool_choice

        started_at = loop.time()
        total_deadline = started_at + s.request_timeout_ms / 1000
        first_deadline = started_at + s.first_byte_timeout_ms / 1000
        seen_event = False

        def budget() -> tuple[float, str]:
            """Seconds we may wait for the next thing, and which timer that is."""
            now = loop.time()
            phase_deadline, why = (first_deadline, "first_event") if not seen_event else (now + s.stream_idle_timeout_ms / 1000, "idle")
            if total_deadline <= phase_deadline:
                return max(0.0, total_deadline - now), "total"
            return max(0.0, phase_deadline - now), why

        response: httpx.Response | None = None
        try:
            request = self._http.build_request(
                "POST",
                f"{s.groq_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {s.groq_api_key}", "Content-Type": "application/json", "Accept": "text/event-stream"},
                content=_compact(body).encode(),
            )
            wait, why = budget()
            try:
                response = await asyncio.wait_for(self._http.send(request, stream=True), wait)
            except asyncio.TimeoutError:
                raise ProviderError(E.TIMEOUT, retryable=why == "first_event") from None
            except httpx.HTTPError:
                raise ProviderError(E.UNAVAILABLE, retryable=True) from None

            if response.status_code >= 400:
                payload = None
                try:
                    payload = json.loads(await asyncio.wait_for(response.aread(), 5))
                except Exception:
                    payload = None
                raise from_http_response(response.status_code, payload, dict(response.headers))

            tool_acc: dict[int, dict[str, str]] = {}
            finish_reason: str | None = None
            usage: dict | None = None
            request_id: str | None = None
            reported_model = model
            text_chars = 0
            saw_output = False
            first_event_ms: int | None = None

            data_iter = iter_sse_data(response.aiter_bytes()).__aiter__()
            while True:
                wait, why = budget()
                try:
                    data = await asyncio.wait_for(data_iter.__anext__(), wait)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    raise ProviderError(E.TIMEOUT, retryable=why == "first_event" and not saw_output) from None
                except httpx.HTTPError:
                    raise ProviderError(E.UNAVAILABLE, retryable=True) from None
                seen_event = True
                try:
                    chunk = json.loads(data)
                except ValueError:
                    raise ProviderError(E.INVALID_RESPONSE) from None
                if not isinstance(chunk, dict):
                    raise ProviderError(E.INVALID_RESPONSE)
                if chunk.get("error"):
                    err = chunk["error"] if isinstance(chunk["error"], dict) else {}
                    status = err.get("status_code") or err.get("status")
                    raise from_http_response(int(status) if str(status).isdigit() else 500, chunk, None)
                if first_event_ms is None:
                    first_event_ms = round((loop.time() - started_at) * 1000)

                request_id = chunk.get("id") or request_id
                reported_model = chunk.get("model") or reported_model
                reported = chunk.get("usage") or (chunk.get("x_groq") or {}).get("usage")
                if reported:
                    usage = reported

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get("delta") or {}

                content = delta.get("content")
                if isinstance(content, str) and content:
                    saw_output = True
                    text_chars += len(content)
                    yield {"type": "text", "text": content}
                tool_deltas = delta.get("tool_calls")
                if isinstance(tool_deltas, list):
                    saw_output = True
                    for tc in tool_deltas:
                        index = tc.get("index") if isinstance(tc.get("index"), int) else 0
                        acc = tool_acc.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        fn = tc.get("function") or {}
                        if tc.get("id"):
                            acc["id"] = tc["id"]
                        if fn.get("name"):
                            acc["name"] += fn["name"]
                        if isinstance(fn.get("arguments"), str):
                            acc["arguments"] += fn["arguments"]
                if choice.get("finish_reason"):
                    finish_reason = "tool_calls" if choice["finish_reason"] == "function_call" else choice["finish_reason"]

            if not finish_reason:
                # Connection ended without a terminal event: a truncated answer is not a complete answer.
                raise ProviderError(E.UNAVAILABLE if saw_output else E.INVALID_RESPONSE, retryable=not saw_output)

            arg_chars = 0
            if tool_acc:
                calls = []
                for _, call in sorted(tool_acc.items()):
                    arg_chars += len(call["arguments"]) + len(call["name"])
                    parsed, input_error = parse_tool_input(call["arguments"])
                    calls.append(
                        {
                            "id": call["id"] or f"call_{uuid.uuid4()}",
                            "name": call["name"],
                            "arguments": call["arguments"],
                            "input": parsed,
                            "inputError": input_error,
                        }
                    )
                yield {"type": "tool_calls", "calls": calls}

            if usage and _is_count(usage.get("prompt_tokens")) and _is_count(usage.get("completion_tokens")):
                total = usage.get("total_tokens")
                yield {
                    "type": "usage",
                    "inputTokens": usage["prompt_tokens"],
                    "outputTokens": usage["completion_tokens"],
                    "totalTokens": total if _is_count(total) else usage["prompt_tokens"] + usage["completion_tokens"],
                    "estimated": False,
                }
            else:
                # Provider reported no usage: ~4 chars/token, flagged so Node can say "estimated".
                input_tokens = math.ceil((len(_compact(wire_messages)) + (len(_compact(body["tools"])) if "tools" in body else 0)) / 4)
                output_tokens = math.ceil((text_chars + arg_chars) / 4)
                yield {"type": "usage", "inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": input_tokens + output_tokens, "estimated": True}

            yield {"type": "done", "finishReason": finish_reason, "model": reported_model, "provider": PROVIDER, "requestId": request_id, "firstEventMs": first_event_ms}
        finally:
            if response is not None:
                try:
                    await asyncio.shield(response.aclose())  # releases the socket even when we are being cancelled
                except Exception:
                    pass


def _is_count(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
