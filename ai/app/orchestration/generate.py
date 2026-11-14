"""Turns provider events into wire frames and decides what a failure looks like on the wire."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator

from ..core import errors as E
from ..core.errors import ProviderError
from ..providers.groq import GroqProvider
from ..schemas.generate import GenerateRequest

log = logging.getLogger("ai.generate")


def encode_frame(event: dict) -> bytes:
    """`event: <type>\\ndata: <json>\\n\\n`. Compact JSON, `type` first (see contracts/frames.json)."""
    data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event['type']}\ndata: {data}\n\n".encode()


async def generate_frames(provider: GroqProvider, body: GenerateRequest, *, request_id: str, max_output_tokens: int, model: str) -> AsyncIterator[bytes]:
    """Always ends with exactly one terminal frame (done|error), unless the consumer cancels us.

    Cancellation (client disconnect) is re-raised untouched so the provider generator is closed
    and the upstream Groq connection is released. Only codes and counts are logged: never content.
    """
    started = time.monotonic()
    produced_output = False
    outcome = "error"
    code: str | None = None
    events = provider.chat(
        model=model,
        messages=[m.model_dump(exclude_none=True) for m in body.messages],
        tools=[t.model_dump(exclude_none=True) for t in body.tools] if body.tools else None,
        tool_choice=body.toolChoice,
        temperature=body.temperature if body.temperature is not None else 0.2,
        max_output_tokens=max_output_tokens,
    )
    try:
        async for event in events:
            if event["type"] in {"text", "tool_calls"}:
                produced_output = True
            yield encode_frame(event)
            if event["type"] == "done":
                outcome = "done"
                return
        # The provider generator ended without a terminal event: say so instead of closing quietly.
        code = E.INVALID_RESPONSE
        yield encode_frame(ProviderError(code, stream_started=produced_output).frame())
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except ProviderError as error:
        code = error.code
        error.stream_started = error.stream_started or produced_output
        yield encode_frame(error.frame())
    except Exception as error:  # a bug on our side; the class name is the only thing safe to log
        code = type(error).__name__
        log.error("unexpected failure type=%s", code)
        yield encode_frame(ProviderError(E.UNAVAILABLE, stream_started=produced_output).frame())
    finally:
        await events.aclose()
        log.info("generate request=%s outcome=%s code=%s ms=%d", request_id, outcome, code, (time.monotonic() - started) * 1000)
