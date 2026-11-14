from __future__ import annotations

from ..limits import Limits
from ..reasons import TOO_MUCH_TEXT, Skip
from ..text import normalize


class Budget:
    """Counts extracted characters so a huge document stops early instead of exhausting memory."""

    def __init__(self, limits: Limits) -> None:
        self.limit = limits.max_text_chars
        self.used = 0

    def add(self, text: str) -> str:
        self.used += len(text)
        if self.used > self.limit:
            raise Skip(TOO_MUCH_TEXT)
        return text


def clean(text: str) -> str:
    return normalize(text)


def decode_text(data: bytes) -> str:
    """UTF-8 (with/without BOM) or UTF-16 with BOM; anything else falls back to cp1252 with replacement."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def looks_binary(data: bytes) -> bool:
    """Real text has no NUL bytes (except UTF-16, which announces itself with a BOM) and few control characters."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return False
    sample = data[:8192]
    if not sample:
        return False
    if b"\x00" in sample:
        return True
    controls = sum(1 for byte in sample if byte < 9 or 13 < byte < 32)
    return controls / len(sample) > 0.05


def row_text(headers: list[str] | None, cells: list[str]) -> str:
    if headers:
        parts = [f"{h}: {c}" if h else c for h, c in zip(headers, cells) if c != ""]
        parts += [c for c in cells[len(headers):] if c != ""]
    else:
        parts = [c for c in cells if c != ""]
    return " | ".join(parts)


def is_header_row(cells: list[str]) -> bool:
    """A header is a row of mostly short, non-numeric, non-empty labels."""
    filled = [c for c in cells if c != ""]
    if len(filled) < 1 or len(filled) < len(cells) / 2:
        return False
    return all(not _numeric(c) and len(c) <= 80 for c in filled)


def _numeric(value: str) -> bool:
    try:
        float(value.replace(",", ""))
        return True
    except ValueError:
        return False
