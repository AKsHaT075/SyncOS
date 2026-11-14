"""In-process VectorStore with the same semantics as the Qdrant adapter. Used by unit tests and as the reference the
Qdrant adapter is compared against (shared contract tests). Not for production."""
from __future__ import annotations

from typing import Sequence

import numpy as np

from .base import DimensionMismatch, Hit, InvalidVector, StoreUnavailable, VectorItem, check_id, point_id, validate_vectors


class MemoryStore:
    def __init__(self) -> None:
        self._collections: dict[str, dict] = {}  # space -> {"dims": int, "points": {id: (vec, payload)}}
        self.down = False  # test switch: simulate an outage

    def _col(self, space_id: str) -> dict:
        if self.down:
            raise StoreUnavailable()
        col = self._collections.get(space_id)
        if col is None:
            raise StoreUnavailable()  # collection missing == the store is not ready for this space
        return col

    def _peek(self, space_id: str) -> dict | None:
        """Like _col, but a space that was never created is simply empty (reads and deletes are no-ops there)."""
        if self.down:
            raise StoreUnavailable()
        return self._collections.get(space_id)

    def ensure_collection(self, space_id: str, dimensions: int) -> None:
        if self.down:
            raise StoreUnavailable()
        col = self._collections.setdefault(space_id, {"dims": dimensions, "points": {}})
        if col["dims"] != dimensions:
            raise DimensionMismatch()

    def upsert(self, *, organization, document, version, ingestion_pipeline, space_id, items: Sequence[VectorItem]) -> int:
        check_id(organization), check_id(document)
        col = self._col(space_id)
        validate_vectors(items, col["dims"])
        for item in items:
            pid = point_id(organization, document, version, ingestion_pipeline, item.chunk_index)
            col["points"][pid] = (item.vector.astype(np.float32).copy(), {"organization": organization, "document": document, "version": version, "chunk_index": item.chunk_index, "text_hash": item.text_hash, "ingestion_pipeline": ingestion_pipeline, "space": space_id})
        return len(items)

    def _match(self, payload: dict, organization: str, document: str | None = None, version: int | None = None, pipeline: str | None = None) -> bool:
        return payload["organization"] == organization and (document is None or payload["document"] == document) and (version is None or payload["version"] == version) and (pipeline is None or payload["ingestion_pipeline"] == pipeline)

    def indexed_hashes(self, *, organization, document, version, ingestion_pipeline, space_id) -> dict[int, str]:
        check_id(organization), check_id(document)
        col = self._peek(space_id)
        return {} if col is None else {p["chunk_index"]: p["text_hash"] for _, p in col["points"].values() if self._match(p, organization, document, version, ingestion_pipeline)}

    def delete_chunks(self, *, organization, document, version, ingestion_pipeline, space_id, chunk_indexes) -> None:
        check_id(organization), check_id(document)
        col = self._peek(space_id)
        if col is None:
            return
        for pid in [k for k, (_, p) in col["points"].items() if self._match(p, organization, document, version, ingestion_pipeline) and p["chunk_index"] in set(chunk_indexes)]:
            del col["points"][pid]

    def delete_document(self, *, organization, document, space_id, keep_version=None) -> int:
        check_id(organization), check_id(document)
        col = self._peek(space_id)
        if col is None:
            return 0
        doomed = [k for k, (_, p) in col["points"].items() if self._match(p, organization, document) and (keep_version is None or p["version"] != keep_version)]
        for k in doomed:
            del col["points"][k]
        return len(doomed)

    def count(self, *, organization, document, space_id, version=None) -> int:
        check_id(organization), check_id(document)
        col = self._peek(space_id)
        return 0 if col is None else sum(1 for _, p in col["points"].values() if self._match(p, organization, document, version))

    def search(self, *, organization, space_id, vector, limit, document_ids=None) -> list[Hit]:
        check_id(organization)
        col = self._col(space_id)
        if vector.shape != (col["dims"],):
            raise DimensionMismatch()
        if not np.isfinite(vector).all():
            raise InvalidVector()
        wanted = set(document_ids) if document_ids is not None else None
        scored = [(float(vec @ vector), p) for vec, p in col["points"].values() if p["organization"] == organization and (wanted is None or p["document"] in wanted)]
        scored.sort(key=lambda t: (-t[0], t[1]["document"], t[1]["chunk_index"]))
        return [Hit(s, p["document"], p["version"], p["chunk_index"], p["text_hash"]) for s, p in scored[:limit]]

    def health(self) -> bool:
        return not self.down

    def drop_collection(self, space_id: str) -> None:
        self._collections.pop(space_id, None)

    def close(self) -> None:
        return None

    # test helper
    def raw_count(self, space_id: str) -> int:
        return len(self._collections.get(space_id, {"points": {}})["points"])
