"""Retrieval: search, authorize, then decide what is actually worth giving the model.

The nearest vector is not necessarily relevant, and the nearest AUTHORIZED vector even less so. So: a hit must clear an
absolute cosine floor to be considered at all, must stay close to the best authorized hit, must not be a near-copy of
a better one, and everything has to fit a token budget. If nothing survives, the answer is "not found" - not a guess.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from ..vectorstore.base import Hit
from .authorizer import Authorizer, key_of
from .config import RagSettings


@dataclass
class Source:
    n: int
    chunk_id: str
    document_id: str
    document_name: str
    version: int
    chunk_index: int
    location: dict
    text: str
    tokens: int
    score: float

    def public(self) -> dict:
        """What may leave this process as a citation: identifiers and location, NEVER the text."""
        return {"n": self.n, "chunkId": self.chunk_id, "documentId": self.document_id, "documentName": self.document_name, "version": self.version, "chunkIndex": self.chunk_index, "location": self.location, "score": round(self.score, 4)}


@dataclass
class Retrieval:
    sources: list[Source] = field(default_factory=list)
    candidates: int = 0
    authorized: int = 0
    rejected: int = 0
    below_threshold: int = 0
    duplicates: int = 0
    rounds: int = 0
    top_score: float | None = None  # best AUTHORIZED score (None if nothing was authorized)

    def stats(self) -> dict:
        return {"candidates": self.candidates, "authorized": self.authorized, "rejected": self.rejected, "belowThreshold": self.below_threshold, "duplicates": self.duplicates, "used": len(self.sources), "rounds": self.rounds, "topScore": None if self.top_score is None else round(self.top_score, 4)}


_STRIP = ".,;:!?()[]{}\"'`«»“”‘’।॥"


def words(text: str) -> frozenset[str]:
    return frozenset(w for w in (t.strip(_STRIP).lower() for t in text.split()) if w)


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def select(authorized: Sequence[Source], cfg: RagSettings, result: Retrieval) -> list[Source]:
    """Relevance window, near-duplicate removal, per-document cap, token budget, then source-aware ordering."""
    ranked = sorted(authorized, key=lambda s: (-s.score, s.document_id, s.chunk_index))
    ranked = [s for s in ranked if s.score >= cfg.min_score]
    if not ranked:
        return []
    best = ranked[0].score
    kept: list[Source] = []
    kept_words: list[frozenset[str]] = []
    per_doc: dict[str, int] = {}
    used = 0
    for s in ranked:
        if s.score < best - cfg.score_window:
            break  # ranked, so everything after is further away still
        if per_doc.get(s.document_id, 0) >= cfg.max_per_document:
            continue
        w = words(s.text)
        if any(jaccard(w, other) >= cfg.near_duplicate for other in kept_words):
            result.duplicates += 1
            continue
        if used + s.tokens > cfg.context_tokens:
            continue  # does not fit; a smaller, lower-ranked chunk still might
        kept.append(s)
        kept_words.append(w)
        per_doc[s.document_id] = per_doc.get(s.document_id, 0) + 1
        used += s.tokens
        if len(kept) >= cfg.top_k:
            break
    # Source-aware grouping: one document's chunks together (best document first, reading order inside it).
    groups: dict[tuple[str, int], list[Source]] = {}
    for s in kept:
        groups.setdefault((s.document_id, s.version), []).append(s)
    ordered: list[Source] = []
    for _, chunks in sorted(groups.items(), key=lambda kv: -max(c.score for c in kv[1])):
        ordered.extend(sorted(chunks, key=lambda c: c.chunk_index))
    for i, s in enumerate(ordered, start=1):
        s.n = i
    return ordered


async def retrieve(*, vector: np.ndarray, store, authorizer: Authorizer, organization: str, space_id: str, cfg: RagSettings) -> Retrieval:
    result = Retrieval()
    seen: dict[tuple, Hit] = {}
    authorized: dict[tuple, Source] = {}
    limits = sorted({cfg.candidates, min(cfg.candidates * 3, cfg.max_candidates), cfg.max_candidates})
    for limit in limits:
        result.rounds += 1
        hits = await asyncio.to_thread(store.search, organization=organization, space_id=space_id, vector=vector, limit=limit)
        fresh = [h for h in hits if key_of(h.document, h.version, h.chunk_index) not in seen]
        for h in hits:
            seen[key_of(h.document, h.version, h.chunk_index)] = h
        askable = [h for h in fresh if h.score >= cfg.min_score]  # below the floor a hit is never sent anywhere
        result.below_threshold += len(fresh) - len(askable)
        result.candidates += len(fresh)
        for start in range(0, len(askable), cfg.authorize_batch):
            batch = askable[start : start + cfg.authorize_batch]
            items, rejected = await authorizer.authorize(batch)
            result.rejected += rejected
            by_key = {key_of(h.document, h.version, h.chunk_index): h for h in batch}
            for item in items:
                key = key_of(item["documentId"], item["version"], item["chunkIndex"])
                authorized[key] = Source(0, item["chunkId"], item["documentId"], item["documentName"], int(item["version"]), int(item["chunkIndex"]), item.get("location", {}), item["text"], item["tokens"], by_key[key].score)
        result.authorized = len(authorized)
        enough = sum(1 for s in authorized.values() if s.score >= cfg.min_score) >= cfg.top_k * 2
        exhausted = len(hits) < limit or (hits and hits[-1].score < cfg.min_score)
        if enough or exhausted:
            break
    result.top_score = max((s.score for s in authorized.values()), default=None)
    result.sources = select(list(authorized.values()), cfg, result)
    return result
