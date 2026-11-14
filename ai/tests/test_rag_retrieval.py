"""Authorizer validation and the retrieval mechanics (widening, thresholds, window, duplicates, budget, grouping)."""
import dataclasses
import hashlib
import json

import httpx
import pytest

from app.rag.authorizer import AuthorizerError, NodeAuthorizer, key_of, validate_items
from app.rag.config import RagSettings, load_rag_settings
from app.rag.retrieval import Retrieval, Source, jaccard, retrieve, select, words
from app.vectorstore.base import Hit
from app.core.config import ConfigError

ORG = "a" * 24
CFG = RagSettings(enabled=True)


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()


def did(i):
    return f"{i:024d}"


def body(i, chunk=0):
    # distinct vocabulary per document, so these are never mistaken for near-duplicates of each other
    return f"topic{i} unique{i} alpha{i} beta{i} gamma{i} delta{i} epsilon{i} chunk{chunk} lorem{i} ipsum{i}"


def hit(i, score, version=1, chunk=0, text=None):
    return Hit(score, did(i), version, chunk, sha(text or body(i, chunk)))


def item_for(h, text=None, name=None):
    text = text or body(int(h.document), h.chunk_index)
    return {"documentId": h.document, "version": h.version, "chunkIndex": h.chunk_index, "chunkId": f"c{int(h.document)}x{h.chunk_index}", "textHash": sha(text), "text": text, "tokens": 20, "documentName": name or f"doc{int(h.document)}.txt", "location": {"charStart": 0, "charEnd": len(text)}}


class ScriptedStore:
    """Returns the first `limit` of a fixed, score-ordered hit list. Records every search."""

    def __init__(self, hits):
        self.hits = sorted(hits, key=lambda h: -h.score)
        self.limits = []

    def search(self, *, organization, space_id, vector, limit, document_ids=None):
        assert organization == ORG
        self.limits.append(limit)
        return self.hits[:limit]


class Allow:
    """Authorizes every candidate whose document id is in `allowed` (or all, if None)."""

    def __init__(self, allowed=None, text_for=None):
        self.allowed, self.text_for, self.calls = allowed, text_for or {}, []

    async def authorize(self, candidates):
        self.calls.append([key_of(c.document, c.version, c.chunk_index) for c in candidates])
        ok = [c for c in candidates if self.allowed is None or int(c.document) in self.allowed]
        items = [item_for(c, self.text_for.get(int(c.document))) for c in ok]
        return validate_items(candidates, items)


# ---- validating Node's answer (defence in depth) ----------------------------------------------------------------------------------

def test_only_items_that_were_asked_about_and_whose_text_matches_are_accepted():
    asked = [hit(1, 0.9), hit(2, 0.9)]
    good = item_for(asked[0])
    extra = item_for(hit(3, 0.9))  # never asked
    tampered = {**item_for(asked[1]), "text": "different text than the vector was made from"}
    wrong_hash = {**item_for(asked[1]), "textHash": sha("other")}
    dup = dict(good)
    items, rejected = validate_items(asked, [good, extra, tampered, wrong_hash, dup, {"nonsense": 1}, {**good, "text": ""}])
    assert [i["documentId"] for i in items] == [good["documentId"]] and rejected == 1  # (1 asked but not returned)


@pytest.mark.parametrize("break_field", [{"chunkId": 5}, {"documentName": None}, {"location": "x"}])
def test_malformed_items_are_dropped(break_field):
    h = hit(1, 0.9)
    items, rejected = validate_items([h], [{**item_for(h), **break_field}])
    assert items == [] and rejected == 1


# ---- the HTTP authorizer -------------------------------------------------------------------------------------------------------------

def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_the_request_to_node_carries_identifiers_and_hashes_only_and_the_callback_token():
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"], seen["body"], seen["url"] = request.headers["authorization"], json.loads(request.content), str(request.url)
        return httpx.Response(200, json={"items": []})

    a = NodeAuthorizer(transport(handler), "http://node.test", "CALLBACK-TOKEN")
    await a.authorize([hit(1, 0.9)])
    assert seen["auth"] == "Bearer CALLBACK-TOKEN" and seen["url"] == "http://node.test/internal/ai/knowledge/authorize"
    assert set(seen["body"]) == {"candidates"} and set(seen["body"]["candidates"][0]) == {"documentId", "version", "chunkIndex", "textHash"}


@pytest.mark.parametrize("status,code", [(401, "AUTHORIZER_REFUSED"), (403, "AUTHORIZER_REFUSED"), (404, "AUTHORIZER_REFUSED"), (409, "AUTHORIZER_REFUSED"), (500, "AUTHORIZER_UNAVAILABLE"), (503, "AUTHORIZER_UNAVAILABLE")])
async def test_node_refusals_and_outages_fail_closed(status, code):
    a = NodeAuthorizer(transport(lambda r: httpx.Response(status, json={})), "http://n", "t")
    with pytest.raises(AuthorizerError) as e:
        await a.authorize([hit(1, 0.9)])
    assert e.value.code == code


async def test_transport_errors_and_garbage_fail_closed_without_leaking():
    def boom(request):
        raise httpx.ConnectError("SECRET-HOST-DETAIL")

    with pytest.raises(AuthorizerError) as e:
        await NodeAuthorizer(transport(boom), "http://n", "t").authorize([hit(1, 0.9)])
    assert "SECRET" not in repr(e.value)
    for body in ("not json", json.dumps({"items": "no"}), json.dumps({})):
        with pytest.raises(AuthorizerError):
            await NodeAuthorizer(transport(lambda r, b=body: httpx.Response(200, content=b)), "http://n", "t").authorize([hit(1, 0.9)])


async def test_nothing_is_sent_for_an_empty_candidate_list():
    called = []
    a = NodeAuthorizer(transport(lambda r: called.append(1) or httpx.Response(200, json={"items": []})), "http://n", "t")
    assert await a.authorize([]) == ([], 0) and called == []


# ---- retrieval -----------------------------------------------------------------------------------------------------------------------------

async def run(store, auth, cfg=CFG):
    import numpy as np

    return await retrieve(vector=np.zeros(4, np.float32), store=store, authorizer=auth, organization=ORG, space_id="abcdef123456", cfg=cfg)


async def test_hits_below_the_floor_are_never_sent_to_node():
    store = ScriptedStore([hit(1, 0.92), hit(2, 0.89), hit(3, 0.60), hit(4, 0.40)])
    auth = Allow()
    r = await run(store, auth)
    asked = {k[0] for batch in auth.calls for k in batch}
    assert asked == {did(1), did(2)} and r.below_threshold == 2
    assert {s.document_id for s in r.sources} == {did(1), did(2)}


async def test_nothing_relevant_means_no_sources_and_no_call_to_node():
    store = ScriptedStore([hit(1, 0.70), hit(2, 0.66)])
    auth = Allow()
    r = await run(store, auth)
    assert r.sources == [] and auth.calls == [] and r.top_score is None


async def test_when_the_best_hits_are_unauthorized_the_search_widens_to_find_authorized_ones():
    unauthorized = [hit(i, 0.95 - i * 0.001) for i in range(1, 41)]  # 40 high-scoring hits the user may not see
    allowed = [hit(100 + i, 0.90 - i * 0.001) for i in range(5)]
    store = ScriptedStore(unauthorized + allowed)
    auth = Allow(allowed={100 + i for i in range(5)})
    r = await run(store, auth)
    assert store.limits == [24, 72]  # widened once, then enough/exhausted
    assert {s.document_id for s in r.sources} == {did(100 + i) for i in range(5)}
    assert r.rejected == 40  # every unauthorized candidate was refused by Node


async def test_widening_stops_when_the_next_hits_are_already_below_the_floor():
    store = ScriptedStore([hit(i, 0.95 - i * 0.05) for i in range(1, 30)])  # scores fall below the floor within the first window
    r = await run(store, Allow())
    assert store.limits == [24]


async def test_widening_is_bounded_by_max_candidates():
    store = ScriptedStore([hit(i, 0.99 - i * 0.00001) for i in range(1, 400)])
    auth = Allow(allowed=set())  # nothing is ever authorized
    cfg = dataclasses.replace(CFG, candidates=10, max_candidates=30)
    r = await run(store, auth, cfg)
    assert store.limits == [10, 30] and r.sources == [] and r.rejected >= 30


async def test_candidates_are_asked_about_in_batches_and_never_twice():
    store = ScriptedStore([hit(i, 0.95 - i * 0.0001) for i in range(1, 130)])
    auth = Allow()
    cfg = dataclasses.replace(CFG, candidates=120, max_candidates=120, authorize_batch=50)
    await run(store, auth, cfg)
    assert [len(b) for b in auth.calls] == [50, 50, 20]  # 120 candidates
    flat = [k for b in auth.calls for k in b]
    assert len(flat) == len(set(flat))


# ---- selection -------------------------------------------------------------------------------------------------------------------------------

def src(i, score, text="alpha beta gamma delta", chunk=0, tokens=100, version=1):
    return Source(0, f"c{i}{chunk}", did(i), f"d{i}", version, chunk, {}, text, tokens, score)


def pick(sources, cfg=CFG):
    r = Retrieval()
    return select(sources, cfg, r), r


def test_the_window_keeps_only_hits_close_to_the_best_authorized_one():
    out, _ = pick([src(1, 0.90, "one one"), src(2, 0.87, "two two"), src(3, 0.80, "three three")])
    assert [s.document_id for s in out] == [did(1), did(2)]  # 0.80 is 0.10 below the best (window 0.05)


def test_the_window_is_relative_to_the_best_AUTHORIZED_hit_not_to_an_unauthorized_one():
    # only a modest authorized hit exists (0.83): it stands on its own because nothing better was authorized
    out, _ = pick([src(1, 0.83, "only one")])
    assert [s.document_id for s in out] == [did(1)]


def test_near_duplicate_text_is_given_once_and_the_better_score_wins():
    a = "All employees receive 24 days of paid leave per year. Up to 5 unused days may be carried over into the next year. Sick leave is separate and allows 10 days per year with a medical certificate for absences longer than 2 days."
    b = "Every employee receives 24 days of paid leave each year. Up to 5 unused days may be carried over into the next year. Sick leave is separate and allows 10 days per year with a medical certificate for absences longer than 2 days."
    out, r = pick([src(1, 0.90, a), src(2, 0.89, b), src(3, 0.88, "completely different text about travel and hotels")])
    assert [s.document_id for s in out] == [did(1), did(3)] and r.duplicates == 1


def test_identical_text_in_different_languages_is_not_a_duplicate():
    assert jaccard(words("24 days of paid leave"), words("24 दिन की सवेतन छुट्टी")) < 0.2


def test_per_document_cap_and_top_k():
    chunks = [src(1, 0.9 - c * 0.001, f"distinct words number {c} unique{c}", chunk=c) for c in range(6)]
    others = [src(i, 0.89 - i * 0.001, f"another {i} topic{i}") for i in range(2, 12)]
    out, _ = pick(chunks + others, dataclasses.replace(CFG, max_per_document=2, top_k=5))
    assert sum(1 for s in out if s.document_id == did(1)) == 2 and len(out) == 5


def test_the_token_budget_is_respected_and_a_smaller_chunk_can_still_fit():
    cfg = dataclasses.replace(CFG, context_tokens=300)
    out, _ = pick([src(1, 0.90, "a1 a2", tokens=200), src(2, 0.89, "b1 b2", tokens=200), src(3, 0.88, "c1 c2", tokens=90)], cfg)
    assert [s.document_id for s in out] == [did(1), did(3)] and sum(s.tokens for s in out) == 290


def test_sources_are_grouped_by_document_in_reading_order_and_numbered_from_one():
    items = [src(1, 0.90, "x1 x2", chunk=3), src(2, 0.89, "y1 y2", chunk=0), src(1, 0.88, "x3 x4", chunk=1), src(2, 0.875, "y3 y4", chunk=2)]
    out, _ = pick(items)
    assert [(s.n, s.document_id, s.chunk_index) for s in out] == [(1, did(1), 1), (2, did(1), 3), (3, did(2), 0), (4, did(2), 2)]


def test_documents_that_differ_only_by_version_are_separate_groups():
    out, _ = pick([src(1, 0.90, "v two text", version=2), src(1, 0.895, "v one text different", version=1)])
    assert {s.version for s in out} == {1, 2} and len(out) == 2


def test_public_citation_data_has_no_text():
    s = src(1, 0.9, "SECRET BODY")
    s.n = 1
    assert "SECRET" not in str(s.public())


# ---- configuration ------------------------------------------------------------------------------------------------------------------------------

def test_rag_is_off_unless_enabled_and_defaults_are_the_calibrated_ones():
    assert load_rag_settings({}).enabled is False
    c = load_rag_settings({"AI_RAG_ENABLED": "true", "AI_EMBEDDING_PROVIDER": "fake", "QDRANT_PATH": "/tmp/q"})
    assert (c.min_score, c.top_k, c.candidates, c.max_candidates, c.context_tokens, c.near_duplicate) == (0.81, 6, 24, 200, 3000, 0.70)


@pytest.mark.parametrize("env", [{"AI_RAG_TOP_K": "0"}, {"AI_RAG_MIN_SCORE": "1.5"}, {"AI_RAG_CANDIDATES": "300"}, {"AI_RAG_CONTEXT_TOKENS": "5"}, {"AI_RAG_MIN_SCORE": "high"}, {"AI_EMBEDDING_PROVIDER": "openai"}])
def test_invalid_rag_settings_are_refused(env):
    with pytest.raises(ConfigError):
        load_rag_settings({"AI_RAG_ENABLED": "true", "QDRANT_PATH": "/tmp/q", **env})


def test_the_fake_embedder_is_refused_in_production():
    with pytest.raises(ConfigError, match="tests only"):
        load_rag_settings({"AI_RAG_ENABLED": "true", "AI_EMBEDDING_PROVIDER": "fake", "AI_ENVIRONMENT": "production", "QDRANT_URL": "https://q:6333", "QDRANT_API_KEY": "k"})
