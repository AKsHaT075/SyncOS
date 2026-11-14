from __future__ import annotations

from ..limits import Limits
from ..model import Extraction
from ..reasons import UNSUPPORTED_FORMAT, Skip
from . import csv_, docx, pdf, pptx, txt, xlsx

EXTRACTORS = {"pdf": pdf.extract, "docx": docx.extract, "xlsx": xlsx.extract, "pptx": pptx.extract, "txt": txt.extract, "csv": csv_.extract}
SUPPORTED = tuple(EXTRACTORS)


def extract(fmt: str, data: bytes, limits: Limits) -> Extraction:
    fn = EXTRACTORS.get(fmt)
    if fn is None:
        raise Skip(UNSUPPORTED_FORMAT)  # doc/xls/ppt/zip/images, or anything unknown
    return fn(data, limits)
