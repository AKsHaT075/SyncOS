"""VectorStore: what the rest of the code may ask of a vector database.

Isolation is structural, not a convention: every method takes `organization` as a REQUIRED keyword argument and
adds it to every filter. There is no call that touches vectors without naming a tenant, and ids are derived from
the organization, so even a bug cannot address another tenant's point. Payload metadata (organization, document,
version...) exists for filtering and cleanup ONLY - it is never an authorization source; Node authorizes.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Protocol, Sequence

import numpy as np

_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_NAMESPACE = uuid.UUID("5f1c7e0e-3b2a-4a55-9d0e-6c1f1b7a9a10")


class VectorStoreError(Exception):
    code = "VECTOR_STORE_ERROR"

    def __init__(self, code: str | None = None) -> None:
        super().__init__(code or self.code)  # a code only: never text, vectors or payloads
        self.code = code or self.code


class StoreUnavailable(VectorStoreError):
    code = "VECTOR_STORE_UNAVAILABLE"


class DimensionMismatch(VectorStoreError):
    code = "VECTOR_DIMENSION_MISMATCH"


class InvalidVector(VectorStoreError):
    code = "VECTOR_INVALID"


class InvalidScope(VectorStoreError):
    code = "VECTOR_INVALID_SCOPE"


@dataclass(frozen=True)
class VectorItem:
    chunk_index: int
    text_hash: str
    vector: np.ndarray


@dataclass(frozen=True)
class Hit:
    score: float
    document: str
    version: int
    chunk_index: int
    text_hash: str


def check_id(value: str, what: str = "id") -> str:
    if not isinstance(value, str) or not _ID.match(value):
        raise InvalidScope()
    return value


def point_id(organization: str, document: str, version: int, ingestion_pipeline: str, chunk_index: int) -> str:
    """Deterministic: re-embedding the same chunk overwrites the same point (idempotent), and the organization is
    part of the id so two tenants can never collide."""
    return str(uuid.uuid5(_NAMESPACE, f"{organization}:{document}:{version}:{ingestion_pipeline}:{chunk_index}"))


def validate_vectors(items: Sequence[VectorItem], dimensions: int) -> None:
    """Rejected BEFORE anything is written: wrong length, non-finite values, or not unit length."""
    for item in items:
        v = item.vector
        if not isinstance(v, np.ndarray) or v.ndim != 1:
            raise InvalidVector()
        if v.shape[0] != dimensions:
            raise DimensionMismatch()
        if not np.isfinite(v).all():
            raise InvalidVector()
        if abs(float(np.linalg.norm(v)) - 1.0) > 1e-3:
            raise InvalidVector()


class VectorStore(Protocol):
    def ensure_collection(self, space_id: str, dimensions: int) -> None:
        """Creates the collection for an embedding space, or VERIFIES an existing one (dimensions, cosine)."""

    def upsert(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str, items: Sequence[VectorItem]) -> int: ...

    def indexed_hashes(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str) -> dict[int, str]:
        """chunk_index -> text_hash for what is currently stored (used to skip unchanged chunks and find stale ones)."""

    def delete_chunks(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str, chunk_indexes: Sequence[int]) -> None: ...

    def delete_document(self, *, organization: str, document: str, space_id: str, keep_version: int | None = None) -> int:
        """Removes the document's vectors (all versions, or all except keep_version). Idempotent. Returns how many."""

    def count(self, *, organization: str, document: str, space_id: str, version: int | None = None) -> int: ...

    def search(self, *, organization: str, space_id: str, vector: np.ndarray, limit: int, document_ids: Sequence[str] | None = None) -> list[Hit]:
        """INTERNAL (Phase 5 will call it after Node has authorized document_ids). Not exposed by any route in Phase 4."""

    def health(self) -> bool: ...

    def drop_collection(self, space_id: str) -> None: ...

    def close(self) -> None: ...
