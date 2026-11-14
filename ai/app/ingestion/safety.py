"""Defensive checks run BEFORE any parser sees an Office file (OOXML files are zip archives)."""
from __future__ import annotations

import io
import zipfile

from .limits import Limits
from .reasons import ARCHIVE_LIMIT, CORRUPT, ENCRYPTED, Skip

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # password-protected OOXML is stored in an OLE container, not a zip
REQUIRED_PART = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}


def inspect_ooxml(data: bytes, fmt: str, limits: Limits) -> None:
    """Raises Skip for encrypted, corrupt or bomb-like archives. Only reads the central directory, never inflates."""
    if data[:8] == OLE_MAGIC:
        raise Skip(ENCRYPTED)  # (or a legacy .doc/.xls/.ppt renamed; either way it is not extractable here)
    if data[:4] != b"PK\x03\x04":
        raise Skip(CORRUPT)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        infos = zf.infolist()
    except (zipfile.BadZipFile, ValueError, OSError):
        raise Skip(CORRUPT) from None

    if len(infos) > limits.max_zip_entries:
        raise Skip(ARCHIVE_LIMIT)
    total = 0
    names = set()
    for info in infos:
        names.add(info.filename)
        if info.flag_bits & 0x1:
            raise Skip(ENCRYPTED)
        if info.filename.startswith("/") or ".." in info.filename.split("/"):
            raise Skip(CORRUPT)
        if info.file_size > limits.max_zip_entry:
            raise Skip(ARCHIVE_LIMIT)
        if info.file_size > limits.ratio_min_bytes and info.file_size / max(info.compress_size, 1) > limits.max_zip_ratio:
            raise Skip(ARCHIVE_LIMIT)
        total += info.file_size
        if total > limits.max_zip_uncompressed:
            raise Skip(ARCHIVE_LIMIT)
    if "[Content_Types].xml" not in names or REQUIRED_PART[fmt] not in names:
        raise Skip(CORRUPT)
