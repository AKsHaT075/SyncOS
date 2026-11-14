"""Text normalization and the (documented) token approximation."""
from __future__ import annotations

import hashlib
import math
import re
import unicodedata

CHARS_PER_TOKEN = 4  # English-ish approximation. NOT a tokenizer: CJK and code tokenize very differently.

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TRAILING_WS = re.compile(r"[ \t ]+\n")
_BLANKS = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    """NFC, \\n newlines, no control characters, no trailing spaces, at most one blank line in a row."""
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").replace(" ", "\n")
    text = _CONTROL.sub("", text)
    text = _TRAILING_WS.sub("\n", text)
    return _BLANKS.sub("\n\n", text).strip()


def approx_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
