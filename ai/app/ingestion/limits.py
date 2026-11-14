from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Limits:
    # input
    max_file_bytes: int = 25 * 1024 * 1024
    # output
    max_text_chars: int = 3_000_000  # extracted text, after normalization
    max_chunks: int = 3000
    min_text_chars: int = 20  # below this a "text" document is treated as having no text (e.g. scanned PDF)
    # structure
    max_pdf_pages: int = 1500
    max_sheets: int = 50
    max_cells: int = 1_000_000
    max_rows: int = 300_000
    max_slides: int = 1000
    max_shape_depth: int = 10
    # archives (OOXML are zips)
    max_zip_entries: int = 3000
    max_zip_uncompressed: int = 150 * 1024 * 1024
    max_zip_entry: int = 60 * 1024 * 1024
    max_zip_ratio: int = 200  # only applied to entries above ratio_min_bytes
    ratio_min_bytes: int = 1024 * 1024
    # execution
    timeout_seconds: float = 90.0
    cpu_seconds: int = 80
    memory_bytes: int = 1536 * 1024 * 1024  # enforced via RLIMIT_AS on Linux; best effort on macOS
    # chunking, in REAL tokens of the embedding model's tokenizer (see sizer.py / chunker.py)
    target_tokens: int = 350
    min_tokens: int = 230
    max_tokens: int = 450
    window_tokens: int = 500  # hard ceiling of a chunk's own tokens: 512 (model) - passage prefix - <s></s> - margin
    overlap_ratio: float = 0.12
    tokenizer_path: str | None = None  # tokenizer.json of the embedding model; REQUIRED (no silent approximation)

    def as_dict(self) -> dict:
        return asdict(self)
