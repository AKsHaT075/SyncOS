from __future__ import annotations

import re

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import CORRUPT, EMPTY, Skip
from .common import Budget, clean, decode_text, looks_binary

_PARA = re.compile(r"\n\s*\n")


def extract(data: bytes, limits: Limits) -> Extraction:
    if looks_binary(data):
        raise Skip(CORRUPT)  # NUL bytes: this is not text
    text = clean(decode_text(data))
    if not text:
        raise Skip(EMPTY)
    Budget(limits).add(text)
    blocks: list[Block] = []
    pos = 0
    for m in list(_PARA.finditer(text)) + [None]:
        end = m.start() if m else len(text)
        piece = text[pos:end]
        if piece.strip():
            blocks.append(Block(text=piece, loc={"charStart": pos, "charEnd": end}))
        pos = m.end() if m else len(text)
    return Extraction("txt", blocks, {"textChars": len(text)})
