"""Machine-readable outcomes. Shared with Node through contracts/ingestion.json (both suites read it)."""
from __future__ import annotations

# Permanent content problems: the job ends `skipped` with one of these. Retrying cannot help.
UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
FILE_TOO_LARGE = "FILE_TOO_LARGE"
ENCRYPTED = "ENCRYPTED"
NO_EXTRACTABLE_TEXT = "NO_EXTRACTABLE_TEXT"  # e.g. a scanned PDF that would need OCR
EMPTY = "EMPTY"
CORRUPT = "CORRUPT"
TOO_MUCH_TEXT = "TOO_MUCH_TEXT"
ARCHIVE_LIMIT = "ARCHIVE_LIMIT"  # decompression-bomb / structure limits
SKIP_REASONS = (UNSUPPORTED_FORMAT, FILE_TOO_LARGE, ENCRYPTED, NO_EXTRACTABLE_TEXT, EMPTY, CORRUPT, TOO_MUCH_TEXT, ARCHIVE_LIMIT)

# Transient problems: the job is retried with backoff, then goes dead.
TIMEOUT = "EXTRACTION_TIMEOUT"
CRASHED = "EXTRACTION_CRASHED"
OUT_OF_MEMORY = "EXTRACTION_OOM"
CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH"
DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
INTERNAL = "INTERNAL_ERROR"
FAIL_REASONS = (TIMEOUT, CRASHED, OUT_OF_MEMORY, CHECKSUM_MISMATCH, DOWNLOAD_FAILED, INTERNAL)


class Skip(Exception):
    """Raised by extractors for a permanent, content-related outcome. Carries a code only, never content."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        assert reason in SKIP_REASONS
        self.reason = reason
