"""The embedding provider interface. Anything that turns text into vectors implements this; nothing else in the
codebase may import a vendor library. Retrieval, jobs and vector stores only see this contract."""
from __future__ import annotations

from typing import Protocol, Sequence

import numpy as np


class EmbeddingError(Exception):
    """Base for provider failures. Messages are codes only: they must never contain text that was being embedded."""

    code = "EMBEDDING_UNAVAILABLE"

    def __init__(self, code: str | None = None) -> None:
        super().__init__(code or self.code)
        self.code = code or self.code


class ModelUnavailable(EmbeddingError):
    """The model could not be loaded (missing files, corrupt ONNX, out of memory, offline with no cache)."""

    code = "EMBEDDING_UNAVAILABLE"


class InputTooLong(EmbeddingError):
    """An input would not fit the model's window. We FAIL instead of letting the model silently truncate it."""

    code = "EMBEDDING_INPUT_TOO_LONG"


class BadOutput(EmbeddingError):
    """The model returned something unusable (wrong shape, NaN/Inf, not normalized)."""

    code = "EMBEDDING_BAD_OUTPUT"


class EmbeddingProvider(Protocol):
    descriptor: dict
    space_id: str
    dimensions: int
    max_tokens: int

    def count_tokens(self, texts: Sequence[str]) -> list[int]:
        """Tokens of each text EXACTLY as the model will see it (prefix and special tokens included)."""

    def embed_passages(self, texts: Sequence[str]) -> np.ndarray:
        """float32 [n, dimensions], L2-normalized. Applies the passage prefix. Raises InputTooLong, never truncates."""

    def embed_query(self, text: str) -> np.ndarray:
        """float32 [dimensions], L2-normalized. Applies the query prefix."""

    def close(self) -> None: ...
