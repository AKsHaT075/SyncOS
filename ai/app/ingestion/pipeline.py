"""bytes -> (extract -> normalize -> chunk) -> a plain, JSON-serializable result. No I/O, no network, no logging."""
from __future__ import annotations

import hashlib

from . import PIPELINE_VERSION
from .chunker import chunk_blocks
from .extractors import extract
from .limits import Limits
from .reasons import NO_EXTRACTABLE_TEXT, Skip
from .sizer import Sizer, build_sizer


def process_bytes(fmt: str, data: bytes, limits: Limits, expected_sha256: str | None = None, sizer: Sizer | None = None) -> dict:
    """Returns {status:'indexed'|'skipped', ...}. Raises only for transient, non-content problems."""
    if expected_sha256 is not None and hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ChecksumMismatch()
    if len(data) > limits.max_file_bytes:
        return {"status": "skipped", "reason": "FILE_TOO_LARGE", "pipelineVersion": PIPELINE_VERSION}
    try:
        extraction = extract(fmt, data, limits)
        sizer = sizer or build_sizer(limits.tokenizer_path)  # raises SizerUnavailable: never a silent chars/4 fallback
        chunks = chunk_blocks(extraction.blocks, limits, sizer)
        if not chunks:
            raise Skip(NO_EXTRACTABLE_TEXT)
    except Skip as skip:
        return {"status": "skipped", "reason": skip.reason, "format": fmt, "pipelineVersion": PIPELINE_VERSION}
    return {
        "status": "indexed",
        "format": extraction.format,
        "pipelineVersion": PIPELINE_VERSION,
        "stats": {**extraction.stats, "chunkCount": len(chunks), "tokenEstimateTotal": sum(c.token_estimate for c in chunks), "maxChunkTokens": max(c.token_estimate for c in chunks)},
        "chunks": [c.as_dict() for c in chunks],
    }


class ChecksumMismatch(Exception):
    pass


def process_file(fmt: str, path: str, limits_dict: dict, expected_sha256: str | None = None) -> dict:
    """Entry point used inside the isolated child process."""
    limits = Limits(**limits_dict)
    with open(path, "rb") as handle:
        data = handle.read(limits.max_file_bytes + 1)
    return process_bytes(fmt, data, limits, expected_sha256)
