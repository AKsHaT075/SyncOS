from __future__ import annotations

import io
import re

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import ARCHIVE_LIMIT, CORRUPT, ENCRYPTED, NO_EXTRACTABLE_TEXT, Skip
from .common import Budget, clean

_BLANK = re.compile(r"\n\s*\n")


def _paragraphs(page_text: str) -> list[str]:
    """pypdf returns one line per visual line. Re-flow lines into paragraphs; blank lines separate paragraphs."""
    out = []
    for chunk in _BLANK.split(page_text):
        lines = [ln.strip() for ln in chunk.split("\n") if ln.strip()]
        if lines:
            out.append(" ".join(lines))
    return out


def extract(data: bytes, limits: Limits) -> Extraction:
    if not data.lstrip(b"\x00\r\n\t ")[:1024].startswith(b"%PDF-") and b"%PDF-" not in data[:1024]:
        raise Skip(CORRUPT)
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise Skip(ENCRYPTED)  # even if an empty password would open it: we never try passwords
        pages = len(reader.pages)
    except Skip:
        raise
    except (PyPdfError, ValueError, KeyError, TypeError, OSError, RecursionError, AttributeError, IndexError):
        raise Skip(CORRUPT) from None
    if pages > limits.max_pdf_pages:
        raise Skip(ARCHIVE_LIMIT)

    budget = Budget(limits)
    blocks: list[Block] = []
    no_text_pages = 0
    unreadable_pages = 0
    for number in range(1, pages + 1):
        try:
            raw = reader.pages[number - 1].extract_text() or ""
        except Exception:  # a single broken page must not lose the whole document
            unreadable_pages += 1
            continue
        paragraphs = _paragraphs(clean(raw))
        if not paragraphs:
            no_text_pages += 1
            continue
        for p in paragraphs:
            blocks.append(Block(text=budget.add(p), loc={"page": number}))

    if budget.used < limits.min_text_chars:
        raise Skip(NO_EXTRACTABLE_TEXT if pages else CORRUPT)  # image-only / scanned: OCR is out of scope
    return Extraction("pdf", blocks, {"pages": pages, "pagesWithoutText": no_text_pages, "unreadablePages": unreadable_pages, "textChars": budget.used})
