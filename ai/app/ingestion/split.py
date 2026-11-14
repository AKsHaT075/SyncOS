"""Splitting an oversized text at the most natural boundary available, tracking character offsets."""
from __future__ import annotations

import re

_SENTENCE_END = re.compile(r"[.!?][\"')\]]*\s+")


def _cut(text: str, start: int, hard_end: int) -> int:
    """Best cut position in (start, hard_end]: paragraph > line > sentence > word > exactly hard_end."""
    window = text[start:hard_end]
    floor = len(window) // 2  # never cut in the first half: avoids tiny pieces
    for needle in ("\n\n", "\n"):
        i = window.rfind(needle, floor)
        if i != -1:
            return start + i + len(needle)
    last = None
    for m in _SENTENCE_END.finditer(window, floor):
        last = m
    if last:
        return start + last.end()
    i = window.rfind(" ", floor)
    return start + i + 1 if i != -1 else hard_end


def split_text(text: str, max_chars: int, base: int = 0) -> list[tuple[str, int, int]]:
    """Pieces of at most max_chars as (piece, start, end) offsets relative to `base`. Pieces tile the text exactly."""
    if len(text) <= max_chars:
        return [(text, base, base + len(text))]
    out: list[tuple[str, int, int]] = []
    pos = 0
    while pos < len(text):
        end = len(text) if len(text) - pos <= max_chars else _cut(text, pos, pos + max_chars)
        out.append((text[pos:end], base + pos, base + end))
        pos = end
    return out
