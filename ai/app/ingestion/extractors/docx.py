from __future__ import annotations

import io
import re

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import CORRUPT, EMPTY, Skip
from ..safety import inspect_ooxml
from .common import Budget, clean

_LEVEL = re.compile(r"(\d+)")


def _heading_level(style_name: str) -> int | None:
    name = (style_name or "").strip().lower()
    if name == "title":
        return 1
    if name.startswith("heading"):
        m = _LEVEL.search(name)
        return int(m.group(1)) if m else 1
    return None


def extract(data: bytes, limits: Limits) -> Extraction:
    inspect_ooxml(data, "docx", limits)
    try:
        document = Document(io.BytesIO(data))
        body = list(document.element.body.iterchildren())
    except Skip:
        raise
    except Exception:
        raise Skip(CORRUPT) from None

    budget = Budget(limits)
    blocks: list[Block] = []
    path: list[str] = []
    tables = 0
    try:
        for child in body:
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "p":
                para = Paragraph(child, document)
                text = clean(para.text)
                if not text:
                    continue
                level = _heading_level(para.style.name if para.style is not None else "")
                if level is not None:
                    path = path[: level - 1] + [text]
                blocks.append(Block(text=budget.add(text), loc={"headingPath": list(path)}, soft=tuple(path)))
            elif tag == "tbl":
                tables += 1
                table = Table(child, document)
                for row in table.rows:
                    seen, cells = set(), []
                    for cell in row.cells:  # merged cells repeat; keep each distinct cell once
                        if id(cell._tc) in seen:
                            continue
                        seen.add(id(cell._tc))
                        cells.append(clean(cell.text).replace("\n", " "))
                    line = " | ".join(c for c in cells if c)
                    if line:
                        blocks.append(Block(text=budget.add(line), loc={"headingPath": list(path)}, soft=tuple(path), sep="\n"))
    except Skip:
        raise
    except Exception:
        raise Skip(CORRUPT) from None
    if not blocks:
        raise Skip(EMPTY)
    return Extraction("docx", blocks, {"tables": tables, "textChars": budget.used})
