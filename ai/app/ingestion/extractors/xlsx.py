from __future__ import annotations

import io
import datetime as dt

from openpyxl import load_workbook

from ..limits import Limits
from ..model import Block, Extraction
from ..reasons import CORRUPT, EMPTY, TOO_MUCH_TEXT, Skip
from ..safety import inspect_ooxml
from .common import Budget, clean, is_header_row, row_text


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return clean(str(value)).replace("\n", " ")


def extract(data: bytes, limits: Limits) -> Extraction:
    inspect_ooxml(data, "xlsx", limits)
    try:
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)  # streaming, cached formula values
    except Exception:
        raise Skip(CORRUPT) from None

    budget = Budget(limits)
    blocks: list[Block] = []
    sheets = rows = cells = 0
    try:
        if len(workbook.sheetnames) > limits.max_sheets:
            raise Skip(TOO_MUCH_TEXT)
        for ws in workbook.worksheets:
            if getattr(ws, "sheet_state", "visible") != "visible":
                continue  # hidden sheets are not indexed
            sheets += 1
            headers: list[str] | None = None
            context = f"Sheet: {ws.title}"
            for number, raw in enumerate(ws.iter_rows(min_row=1, values_only=True), start=1):
                if number > limits.max_rows:
                    raise Skip(TOO_MUCH_TEXT)
                values = [_cell(v) for v in raw]
                cells += len(values)
                if cells > limits.max_cells:
                    raise Skip(TOO_MUCH_TEXT)
                if not any(values):
                    continue
                if headers is None and is_header_row(values):
                    headers = values
                    context = f"Sheet: {ws.title}\nColumns: " + " | ".join(h for h in values if h)
                    continue
                body = row_text(headers, values)
                if body:
                    rows += 1
                    blocks.append(Block(text=budget.add(body), loc={"sheet": ws.title, "rowStart": number, "rowEnd": number}, hard=ws.title, context=context, sep="\n"))
    except Skip:
        raise
    except Exception:
        raise Skip(CORRUPT) from None
    finally:
        try:
            workbook.close()
        except Exception:
            pass
    if not blocks:
        raise Skip(EMPTY)
    return Extraction("xlsx", blocks, {"sheets": sheets, "rows": rows, "textChars": budget.used})
