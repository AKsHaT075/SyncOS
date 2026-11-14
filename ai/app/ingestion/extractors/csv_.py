from __future__ import annotations

import csv
import io

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import CORRUPT, EMPTY, TOO_MUCH_TEXT, Skip
from .common import Budget, clean, decode_text, is_header_row, looks_binary, row_text


def extract(data: bytes, limits: Limits) -> Extraction:
    if looks_binary(data):
        raise Skip(CORRUPT)
    text = decode_text(data).replace("\x00", "")
    if not text.strip():
        raise Skip(EMPTY)
    try:
        dialect = csv.Sniffer().sniff(text[:16384], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    csv.field_size_limit(1_000_000)
    budget = Budget(limits)
    headers: list[str] | None = None
    context = ""
    blocks: list[Block] = []
    rows = 0
    try:
        for number, raw in enumerate(csv.reader(io.StringIO(text, newline=""), dialect), start=1):
            if number > limits.max_rows:
                raise Skip(TOO_MUCH_TEXT)
            cells = [clean(c) for c in raw]
            if not any(cells):
                continue
            if headers is None and not context and is_header_row(cells):
                headers = cells
                context = "Columns: " + " | ".join(h for h in cells if h)
                continue
            body = row_text(headers, cells)
            if body:
                rows += 1
                blocks.append(Block(text=budget.add(body), loc={"rowStart": number, "rowEnd": number}, context=context, sep="\n"))
    except csv.Error:
        raise Skip(CORRUPT) from None
    if not blocks:
        raise Skip(EMPTY)
    return Extraction("csv", blocks, {"rows": rows, "textChars": budget.used})
