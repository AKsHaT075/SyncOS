"""Qdrant adapter (qdrant-client 1.20). One collection per EMBEDDING SPACE, so incompatible vectors can never share a
collection. Modes: a Qdrant server (url + api key + TLS, the production path), or qdrant-client's embedded local mode
(path / ":memory:", single process, development and tests only).

Point = deterministic uuid5 id + 384-d cosine vector + payload {organization, document, version, chunk_index,
text_hash, ingestion_pipeline, space}. There is NO text and NO permission data in the payload.
"""
from __future__ import annotations

import logging
import warnings
from typing import Sequence

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client import models as qm

from .base import (
    DimensionMismatch,
    Hit,
    StoreUnavailable,
    VectorItem,
    VectorStoreError,
    check_id,
    point_id,
    validate_vectors,
)
from .config import VectorStoreConfig

log = logging.getLogger("ai.vectorstore")
BATCH = 128


class QdrantStore:
    def __init__(self, config: VectorStoreConfig, client: QdrantClient | None = None) -> None:
        self.config = config
        self.prefix = config.collection_prefix
        self._client = client or self._connect(config)

    @staticmethod
    def _connect(config: VectorStoreConfig) -> QdrantClient:
        try:
            if config.url:
                return QdrantClient(url=config.url, api_key=config.api_key, timeout=int(config.timeout_seconds), prefer_grpc=False)
            return QdrantClient(path=config.path) if config.path else QdrantClient(":memory:")
        except Exception as error:
            log.error("vector store connection failed: %s", type(error).__name__)
            raise StoreUnavailable() from None

    # ------------------------------------------------------------------ helpers

    def _name(self, space_id: str) -> str:
        if not space_id.isalnum():
            raise VectorStoreError("VECTOR_INVALID_SCOPE")
        return f"{self.prefix}_{space_id}"

    def _call(self, fn, *args, **kwargs):
        """Runs a client call; every failure becomes a typed, content-free error."""
        try:
            return fn(*args, **kwargs)
        except VectorStoreError:
            raise
        except Exception as error:
            status = getattr(error, "status_code", None)
            log.error("vector store call failed: %s status=%s", type(error).__name__, status)
            if status in (401, 403):
                raise StoreUnavailable("VECTOR_STORE_AUTH") from None
            raise StoreUnavailable() from None

    @staticmethod
    def _org_filter(organization: str, document: str | None = None, version: int | None = None, pipeline: str | None = None, extra_must=None, must_not=None) -> qm.Filter:
        must = [qm.FieldCondition(key="organization", match=qm.MatchValue(value=organization))]
        if document is not None:
            must.append(qm.FieldCondition(key="document", match=qm.MatchValue(value=document)))
        if version is not None:
            must.append(qm.FieldCondition(key="version", match=qm.MatchValue(value=version)))
        if pipeline is not None:
            must.append(qm.FieldCondition(key="ingestion_pipeline", match=qm.MatchValue(value=pipeline)))
        return qm.Filter(must=must + list(extra_must or []), must_not=list(must_not or []) or None)

    def _exists(self, space_id: str) -> bool:
        return bool(self._call(self._client.collection_exists, self._name(space_id)))

    # ------------------------------------------------------------------ interface

    def ensure_collection(self, space_id: str, dimensions: int) -> None:
        name = self._name(space_id)
        if not self._exists(space_id):
            try:
                self._call(self._client.create_collection, name, vectors_config=qm.VectorParams(size=dimensions, distance=qm.Distance.COSINE))
            except StoreUnavailable:
                if not self._exists(space_id):  # lost a creation race with another worker -> fine; otherwise a real failure
                    raise
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # embedded local mode ignores payload indexes and says so
                self._call(self._client.create_payload_index, name, "organization", qm.KeywordIndexParams(type=qm.KeywordIndexType.KEYWORD, is_tenant=True))
                self._call(self._client.create_payload_index, name, "document", qm.PayloadSchemaType.KEYWORD)
                self._call(self._client.create_payload_index, name, "version", qm.PayloadSchemaType.INTEGER)
        info = self._call(self._client.get_collection, name)
        vectors = info.config.params.vectors
        size = getattr(vectors, "size", None)
        distance = getattr(vectors, "distance", None)
        if size != dimensions or distance != qm.Distance.COSINE:
            raise DimensionMismatch()  # the collection for this space id disagrees with the space definition: refuse to write

    def upsert(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str, items: Sequence[VectorItem]) -> int:
        check_id(organization), check_id(document)
        validate_vectors(items, self._dimensions(space_id))  # BEFORE anything is sent
        name = self._name(space_id)
        for start in range(0, len(items), BATCH):
            points = [
                qm.PointStruct(
                    id=point_id(organization, document, version, ingestion_pipeline, it.chunk_index),
                    vector=it.vector.astype(np.float32).tolist(),
                    payload={"organization": organization, "document": document, "version": version, "chunk_index": it.chunk_index, "text_hash": it.text_hash, "ingestion_pipeline": ingestion_pipeline, "space": space_id},
                )
                for it in items[start : start + BATCH]
            ]
            self._call(self._client.upsert, name, points=points, wait=True)
        return len(items)

    def _dimensions(self, space_id: str) -> int:
        info = self._call(self._client.get_collection, self._name(space_id))
        return int(info.config.params.vectors.size)

    def indexed_hashes(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str) -> dict[int, str]:
        check_id(organization), check_id(document)
        if not self._exists(space_id):
            return {}
        flt = self._org_filter(organization, document, version, ingestion_pipeline)
        out: dict[int, str] = {}
        offset = None
        while True:
            records, offset = self._call(self._client.scroll, self._name(space_id), scroll_filter=flt, limit=256, offset=offset, with_payload=["chunk_index", "text_hash"], with_vectors=False)
            for r in records:
                out[int(r.payload["chunk_index"])] = str(r.payload["text_hash"])
            if offset is None:
                return out

    def delete_chunks(self, *, organization: str, document: str, version: int, ingestion_pipeline: str, space_id: str, chunk_indexes: Sequence[int]) -> None:
        check_id(organization), check_id(document)
        if not chunk_indexes or not self._exists(space_id):
            return
        flt = self._org_filter(organization, document, version, ingestion_pipeline, extra_must=[qm.FieldCondition(key="chunk_index", match=qm.MatchAny(any=[int(i) for i in chunk_indexes]))])
        self._call(self._client.delete, self._name(space_id), points_selector=qm.FilterSelector(filter=flt), wait=True)

    def delete_document(self, *, organization: str, document: str, space_id: str, keep_version: int | None = None) -> int:
        check_id(organization), check_id(document)
        if not self._exists(space_id):
            return 0  # nothing to delete in a space that was never populated: idempotent
        must_not = [qm.FieldCondition(key="version", match=qm.MatchValue(value=keep_version))] if keep_version is not None else None
        flt = self._org_filter(organization, document, must_not=must_not)
        n = self._call(self._client.count, self._name(space_id), count_filter=flt, exact=True).count
        if n:
            self._call(self._client.delete, self._name(space_id), points_selector=qm.FilterSelector(filter=flt), wait=True)
        return int(n)

    def count(self, *, organization: str, document: str, space_id: str, version: int | None = None) -> int:
        check_id(organization), check_id(document)
        if not self._exists(space_id):
            return 0
        return int(self._call(self._client.count, self._name(space_id), count_filter=self._org_filter(organization, document, version), exact=True).count)

    def search(self, *, organization: str, space_id: str, vector: np.ndarray, limit: int, document_ids: Sequence[str] | None = None) -> list[Hit]:
        check_id(organization)
        if vector.shape != (self._dimensions(space_id),):
            raise DimensionMismatch()
        extra = [qm.FieldCondition(key="document", match=qm.MatchAny(any=list(document_ids)))] if document_ids is not None else None
        res = self._call(self._client.query_points, self._name(space_id), query=vector.astype(np.float32).tolist(), query_filter=self._org_filter(organization, extra_must=extra), limit=limit, with_payload=True)
        return [Hit(float(p.score), str(p.payload["document"]), int(p.payload["version"]), int(p.payload["chunk_index"]), str(p.payload["text_hash"])) for p in res.points]

    def health(self) -> bool:
        try:
            self._client.get_collections()
            return True
        except Exception:
            return False

    def drop_collection(self, space_id: str) -> None:
        if self._exists(space_id):
            self._call(self._client.delete_collection, self._name(space_id))

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass
