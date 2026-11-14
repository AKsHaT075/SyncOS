"""Shared RAG test scaffolding: builds an index from the evaluation corpus and simulates NODE's authorization decisions.

SimAuthorizer applies the same RULES Node applies (organization, not trashed/private-to-someone-else, current version,
text hash). It exists so retrieval QUALITY can be measured here; the real rules are exercised against the real Node
service in backend/tests/integration/rag-*.test.js.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from app.rag.authorizer import key_of, validate_items
from app.vectorstore.base import VectorItem

ORG = "a" * 24
CORPUS = json.loads((Path(__file__).resolve().parent / "eval" / "rag_corpus.json").read_text())


def doc_id(name: str) -> str:
    return hashlib.sha1(name.encode()).hexdigest()[:24]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_index(provider, store, space_id=None, org=ORG, corpus=CORPUS):
    space = space_id or provider.space_id
    store.ensure_collection(space, provider.dimensions)
    texts = [d["text"] for d in corpus["documents"]]
    vectors = provider.embed_passages(texts)
    for d, v in zip(corpus["documents"], vectors):
        store.upsert(organization=org, document=doc_id(d["id"]), version=d["version"], ingestion_pipeline="p2", space_id=space, items=[VectorItem(0, sha(d["text"]), v)])
    return space


class SimAuthorizer:
    """Mimics Node. `denied` lets a test add per-document denials; `calls` records what Python asked about."""

    def __init__(self, corpus=CORPUS, denied=(), fail_with=None):
        self.docs = {(doc_id(d["id"]), d["version"]): d for d in corpus["documents"]}
        self.current = {doc_id(d["id"]): d.get("current_version", 1) for d in corpus["documents"]}
        self.denied = {doc_id(x) for x in denied}
        self.fail_with = fail_with
        self.calls: list[list] = []

    async def authorize(self, candidates):
        self.calls.append([key_of(c.document, c.version, c.chunk_index) for c in candidates])
        if self.fail_with:
            raise self.fail_with
        items = []
        for c in candidates:
            d = self.docs.get((c.document, c.version))
            if d is None or d["visibility"] in {"private-other", "trashed"} or c.document in self.denied:
                continue
            if self.current[c.document] != c.version:
                continue  # a superseded version
            if sha(d["text"]) != c.text_hash:
                continue
            items.append({"documentId": c.document, "version": c.version, "chunkIndex": c.chunk_index, "chunkId": f"chunk-{c.document[:6]}-{c.version}-{c.chunk_index}", "textHash": c.text_hash, "text": d["text"], "tokens": max(1, len(d["text"]) // 4), "documentName": f"{d['id']}.txt", "location": {"charStart": 0, "charEnd": len(d["text"])}})
        return validate_items(candidates, items)


def topic_of(document_id: str, corpus=CORPUS) -> str | None:
    for d in corpus["documents"]:
        if doc_id(d["id"]) == document_id:
            return d["topic"]
    return None
