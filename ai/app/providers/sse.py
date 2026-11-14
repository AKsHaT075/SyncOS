"""Minimal Server-Sent-Events parsing for an async byte stream (Groq's response body)."""
from __future__ import annotations

import codecs
from typing import AsyncIterator


def _boundary(text: str) -> tuple[int, int] | None:
    lf, crlf = text.find("\n\n"), text.find("\r\n\r\n")
    if lf == -1 and crlf == -1:
        return None
    if crlf == -1 or (lf != -1 and lf < crlf):
        return lf, 2
    return crlf, 4


def _data(raw_event: str) -> str | None:
    lines = [line[5:].removeprefix(" ") for line in raw_event.splitlines() if line.startswith("data:")]
    return "\n".join(lines) if lines else None


async def iter_sse_data(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Yields each event's `data:` payload; stops at `[DONE]`. Comment lines are ignored."""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    buffer = ""
    async for chunk in chunks:
        buffer += decoder.decode(chunk)
        while (found := _boundary(buffer)) is not None:
            index, length = found
            raw, buffer = buffer[:index], buffer[index + length :]
            data = _data(raw)
            if data is None:
                continue
            if data == "[DONE]":
                return
            yield data
    buffer += decoder.decode(b"", final=True)
    tail = _data(buffer)
    if tail is not None and tail != "[DONE]":
        yield tail
