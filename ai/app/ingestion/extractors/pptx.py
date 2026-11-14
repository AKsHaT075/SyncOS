from __future__ import annotations

import io

from pptx import Presentation
from pptx.util import Emu  # noqa: F401  (import check only)

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import ARCHIVE_LIMIT, CORRUPT, EMPTY, Skip
from ..safety import inspect_ooxml
from .common import Budget, clean


def _shape_lines(shape, depth: int, limits: Limits) -> list[str]:
    if depth > limits.max_shape_depth:
        raise Skip(ARCHIVE_LIMIT)
    lines: list[str] = []
    if getattr(shape, "shape_type", None) == 6 and hasattr(shape, "shapes"):  # group
        for child in shape.shapes:
            lines += _shape_lines(child, depth + 1, limits)
        return lines
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            cells = [clean(c.text).replace("\n", " ") for c in row.cells]
            line = " | ".join(c for c in cells if c)
            if line:
                lines.append(line)
        return lines
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        for paragraph in shape.text_frame.paragraphs:
            text = clean("".join(run.text for run in paragraph.runs) or paragraph.text)
            if text:
                lines.append(text)
    return lines


def extract(data: bytes, limits: Limits) -> Extraction:
    inspect_ooxml(data, "pptx", limits)
    try:
        presentation = Presentation(io.BytesIO(data))
        slides = list(presentation.slides)
    except Exception:
        raise Skip(CORRUPT) from None
    if len(slides) > limits.max_slides:
        raise Skip(ARCHIVE_LIMIT)

    budget = Budget(limits)
    blocks: list[Block] = []
    try:
        for number, slide in enumerate(slides, start=1):
            lines: list[str] = []
            title = slide.shapes.title if slide.shapes.title is not None else None
            if title is not None:
                lines += _shape_lines(title, 0, limits)
            for shape in slide.shapes:
                if title is not None and shape.shape_id == title.shape_id:
                    continue
                lines += _shape_lines(shape, 0, limits)
            if lines:
                blocks.append(Block(text=budget.add("\n".join(lines)), loc={"slide": number}, soft=number))
    except Skip:
        raise
    except Exception:
        raise Skip(CORRUPT) from None
    if not blocks:
        raise Skip(EMPTY)
    return Extraction("pptx", blocks, {"slides": len(slides), "slidesWithText": len(blocks), "textChars": budget.used})
