import asyncio
import hashlib
import logging

import numpy as np
import pytest

from app.embeddings.config import EmbeddingWorkerSettings, load_embedding_worker_settings
from app.embeddings.fake_provider import FakeProvider
from app.embeddings.provider import BadOutput, InputTooLong, ModelUnavailable
from app.embeddings.worker import Worker, _main
from app.ingestion.node_client import LockLost, NodeError
from app.vectorstore.base import StoreUnavailable, VectorItem
from app.vectorstore.memory_store import MemoryStore
from app.core.config import ConfigError

ORG_A, ORG_B = "a" * 24, "b" * 24
DOC, DOC2 = "d" * 24, "e" * 24
SECRET = "BOARD-CONFIDENTIAL salary table for the whole company"


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()


def make_chunks(n, tag="chunk"):
    return [{"index": i, "text": f"{tag} {i} about annual leave and policy", "textHash": sha(f"{tag} {i}")} for i in range(n)]


class FakeNode:
    """Stands in for EmbeddingNodeClient. Serves one scripted queue of jobs and the chunks of each."""

    def __init__(self, jobs=None, chunks=None):
        self.queue = list(jobs or [])
        self.chunks_by_doc = chunks or {}
        self.submitted = []
        self.heartbeats = 0
        self.fail_chunks = None
        self.lose_lock_on_heartbeat = False
        self.claimed_for = []

    async def claim_embedding(self, space_id, ingestion_pipeline):
        self.claimed_for.append((space_id, ingestion_pipeline))
        return self.queue.pop(0) if self.queue else None

    async def heartbeat_embedding(self, job_id, token):
        self.heartbeats += 1
        if self.lose_lock_on_heartbeat:
            raise LockLost()

    async def chunks(self, job_id, token, after, limit):
        if self.fail_chunks:
            raise self.fail_chunks
        job = next(j for j in self.all_jobs if j["id"] == job_id)
        rows = [c for c in self.chunks_by_doc[(job["organization"], job["document"], job["version"])] if c["index"] > after]
        page = rows[:limit]
        return {"chunks": page, "next": page[-1]["index"] if len(rows) > limit else None}

    async def submit_embedding(self, job_id, token, result):
        self.submitted.append(result)
        return {"ok": True}

    async def close(self):
        pass

    @property
    def all_jobs(self):
        return getattr(self, "_all", [])


def embed_job(space, org=ORG_A, doc=DOC, version=1, job_id="j1", **kw):
    return {"id": job_id, "kind": "embed", "organization": org, "document": doc, "version": version, "ingestionPipeline": "p2", "spaceId": space, "lockToken": "t" * 20, "leaseSeconds": 5, "attempt": 1, **kw}


def purge_job(space, org=ORG_A, doc=DOC, keep=None, generation=1, job_id="p1"):
    return {"id": job_id, "kind": "purge", "organization": org, "document": doc, "version": 0, "ingestionPipeline": "*", "spaceId": space, "keepVersion": keep, "generation": generation, "lockToken": "t" * 20, "leaseSeconds": 5, "attempt": 1}


def setup(jobs, chunks, provider=None, store=None, **settings):
    provider = provider or FakeProvider()
    store = store or MemoryStore()
    node = FakeNode(jobs, chunks)
    node._all = list(jobs)
    worker = Worker(EmbeddingWorkerSettings(page_size=settings.pop("page_size", 4), batch_size=settings.pop("batch_size", 3), **settings), provider, store, client=node)
    store.ensure_collection(provider.space_id, provider.dimensions)
    return worker, node, provider, store


def stored(store, provider, org=ORG_A, doc=DOC, version=1):
    return store.indexed_hashes(organization=org, document=doc, version=version, ingestion_pipeline="p2", space_id=provider.space_id)


async def test_embeds_a_document_and_reports_only_counts_and_identity():
    p = FakeProvider()
    chunks = make_chunks(10)
    w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): chunks}, provider=p)
    assert await w.run_once() is True
    (result,) = node.submitted
    assert result == {
        "status": "embedded", "spaceId": p.space_id, "model": "syncos/fake-hash", "revision": "test", "dimensions": 384,
        "count": 10, "digest": hashlib.sha256("\n".join(c["textHash"] for c in chunks).encode()).hexdigest(), "embedded": 10,
    }
    assert stored(store, p) == {c["index"]: c["textHash"] for c in chunks}
    assert "text" not in str(result) and "vector" not in str(result)


async def test_pages_are_fetched_and_the_worker_asks_for_its_own_space_and_pipeline():
    p = FakeProvider()
    w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): make_chunks(11)}, provider=p, page_size=3)
    await w.run_once()
    assert node.claimed_for == [(p.space_id, "p2")]
    assert len(stored(store, p)) == 11


async def test_rerunning_the_same_job_is_idempotent_and_embeds_nothing_twice():
    p = FakeProvider()
    chunks = make_chunks(7)
    jobs = [embed_job(p.space_id, job_id="j1"), embed_job(p.space_id, job_id="j2")]
    w, node, p, store = setup(jobs, {(ORG_A, DOC, 1): chunks}, provider=p)
    await w.run_once()
    calls = p.calls
    await w.run_once()
    assert p.calls == calls  # nothing new to embed: the model was not called again
    assert node.submitted[1]["embedded"] == 0 and node.submitted[1]["count"] == 7
    assert store.raw_count(p.space_id) == 7  # no duplicate points


async def test_only_changed_chunks_are_re_embedded_and_stale_tail_is_removed():
    p = FakeProvider()
    v1 = make_chunks(6)
    v1b = make_chunks(4)
    v1b[2] = {"index": 2, "text": "this chunk was edited", "textHash": sha("edited")}
    w, node, p, store = setup([embed_job(p.space_id, job_id="j1"), embed_job(p.space_id, job_id="j2")], {(ORG_A, DOC, 1): v1}, provider=p)
    await w.run_once()
    node.chunks_by_doc[(ORG_A, DOC, 1)] = v1b  # the same version re-extracted: smaller, one chunk changed
    await w.run_once()
    assert node.submitted[1]["embedded"] == 1 and node.submitted[1]["count"] == 4
    assert stored(store, p) == {c["index"]: c["textHash"] for c in v1b}  # chunks 4 and 5 are gone


async def test_two_workers_running_the_same_job_cannot_create_duplicates():
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, 384)
    chunks = make_chunks(9)
    w1, n1, _, _ = setup([embed_job(p.space_id, job_id="j1")], {(ORG_A, DOC, 1): chunks}, provider=p, store=store)
    w2, n2, _, _ = setup([embed_job(p.space_id, job_id="j1")], {(ORG_A, DOC, 1): chunks}, provider=p, store=store)
    assert all(await asyncio.gather(w1.run_once(), w2.run_once()))  # a zombie/duplicate holder of the same job
    assert store.raw_count(p.space_id) == 9
    assert n1.submitted[0]["digest"] == n2.submitted[0]["digest"]


async def test_workers_on_different_documents_interleave_safely():
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, 384)
    ws = [setup([embed_job(p.space_id, doc=f"{i:024d}", job_id=f"j{i}")], {(ORG_A, f"{i:024d}", 1): make_chunks(5, f"doc{i}")}, provider=p, store=store)[0] for i in range(6)]
    assert all(await asyncio.gather(*[w.run_once() for w in ws]))
    assert store.raw_count(p.space_id) == 30


async def test_a_purge_removes_versions_and_is_idempotent():
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, 384)
    for v in (1, 2):
        store.upsert(organization=ORG_A, document=DOC, version=v, ingestion_pipeline="p2", space_id=p.space_id, items=[VectorItem(i, f"h{v}{i}", p.embed_passages([f"t{v}{i}"])[0]) for i in range(3)])
    jobs = [purge_job(p.space_id, keep=2, generation=4, job_id="p1"), purge_job(p.space_id, keep=2, generation=4, job_id="p2")]
    w, node, p, store = setup(jobs, {}, provider=p, store=store)
    await w.run_once()
    assert node.submitted[0] == {"status": "completed", "deleted": 3, "generation": 4}
    assert stored(store, p, version=1) == {} and len(stored(store, p, version=2)) == 3
    await w.run_once()
    assert node.submitted[1] == {"status": "completed", "deleted": 0, "generation": 4}  # again: nothing left, still fine


async def test_a_purge_for_one_organization_never_touches_another():
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, 384)
    for org in (ORG_A, ORG_B):
        store.upsert(organization=org, document=DOC, version=1, ingestion_pipeline="p2", space_id=p.space_id, items=[VectorItem(0, "h", p.embed_passages(["same"])[0])])
    w, node, p, store = setup([purge_job(p.space_id, org=ORG_A)], {}, provider=p, store=store)
    await w.run_once()
    assert stored(store, p, org=ORG_A) == {} and len(stored(store, p, org=ORG_B)) == 1


async def test_embedding_is_scoped_to_the_organization_of_the_job():
    p = FakeProvider()
    w, node, p, store = setup([embed_job(p.space_id, org=ORG_B)], {(ORG_B, DOC, 1): make_chunks(3)}, provider=p)
    await w.run_once()
    assert stored(store, p, org=ORG_B) and stored(store, p, org=ORG_A) == {}


# ---- failure handling --------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "arrange,reason",
    [
        (lambda p, s, n: setattr(s, "down", True), "VECTOR_STORE_UNAVAILABLE"),
        (lambda p, s, n: setattr(p, "fail_next", ModelUnavailable()), "EMBEDDING_UNAVAILABLE"),
        (lambda p, s, n: setattr(p, "fail_next", InputTooLong()), "EMBEDDING_INPUT_TOO_LONG"),
        (lambda p, s, n: setattr(p, "fail_next", BadOutput()), "EMBEDDING_BAD_OUTPUT"),
        (lambda p, s, n: setattr(n, "fail_chunks", NodeError("node 500")), "NODE_UNAVAILABLE"),
        (lambda p, s, n: setattr(p, "fail_next", RuntimeError(SECRET)), "INTERNAL_ERROR"),
    ],
)
async def test_failures_are_reported_as_codes_only(arrange, reason, caplog):
    caplog.set_level(logging.DEBUG)
    p = FakeProvider()
    w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): make_chunks(3)}, provider=p)
    arrange(p, store, node)
    await w.run_once()
    assert node.submitted == [{"status": "failed", "reason": reason}]
    assert SECRET not in caplog.text and "annual leave" not in caplog.text


async def test_a_dimension_mismatch_in_the_store_is_a_failure_not_a_write():
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, 16)  # the collection for this space id has the wrong dimensions
    node = FakeNode([embed_job(p.space_id)], {(ORG_A, DOC, 1): make_chunks(2)})
    node._all = list(node.queue)
    w = Worker(EmbeddingWorkerSettings(), p, store, client=node)
    await w.run_once()
    assert node.submitted == [{"status": "failed", "reason": "VECTOR_DIMENSION_MISMATCH"}]
    assert store.raw_count(p.space_id) == 0


async def test_a_job_for_a_space_the_worker_cannot_produce_is_refused():
    p = FakeProvider()
    w, node, p, store = setup([embed_job("ffffffffffff")], {(ORG_A, DOC, 1): make_chunks(2)}, provider=p)
    await w.run_once()
    assert node.submitted == [{"status": "failed", "reason": "INTERNAL_ERROR"}]
    assert store.raw_count(p.space_id) == 0


async def test_non_contiguous_or_empty_chunks_are_not_embedded():
    p = FakeProvider()
    bad = make_chunks(3)
    bad[1]["index"] = 5
    for chunks in (bad, []):
        w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): chunks}, provider=p)
        await w.run_once()
        assert node.submitted == [{"status": "failed", "reason": "INTERNAL_ERROR"}]


async def test_the_stored_set_is_verified_before_success_is_reported():
    p = FakeProvider()
    store = MemoryStore()

    class Lossy(MemoryStore):
        def upsert(self, **kw):  # silently loses a point, like a damaged index
            kw["items"] = list(kw["items"])[:-1]
            return super().upsert(**kw)

    store = Lossy()
    w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): make_chunks(5)}, provider=p, store=store)
    await w.run_once()
    assert node.submitted == [{"status": "failed", "reason": "VECTOR_COUNT_MISMATCH"}]


async def test_losing_the_lock_stops_the_work_and_submits_nothing():
    p = FakeProvider()
    w, node, p, store = setup([embed_job(p.space_id, leaseSeconds=0.2)], {(ORG_A, DOC, 1): make_chunks(40)}, provider=p, batch_size=1)
    node.lose_lock_on_heartbeat = True
    real = p.embed_passages

    def slow(texts):
        import time

        time.sleep(0.1)
        return real(texts)

    p.embed_passages = slow
    await w.run_once()
    assert node.submitted == []  # someone else owns the job now: do not report
    assert store.raw_count(p.space_id) < 40  # and it stopped early


async def test_heartbeats_continue_while_a_long_job_runs():
    p = FakeProvider()
    w, node, p, store = setup([embed_job(p.space_id, leaseSeconds=0.3)], {(ORG_A, DOC, 1): make_chunks(12)}, provider=p, batch_size=1)
    real = p.embed_passages

    def slow(texts):
        import time

        time.sleep(0.08)
        return real(texts)

    p.embed_passages = slow
    await w.run_once()
    assert node.heartbeats >= 2 and node.submitted[0]["status"] == "embedded"


async def test_nothing_to_do_and_claim_failures_are_quiet():
    p = FakeProvider()
    w, node, p, store = setup([], {}, provider=p)
    assert await w.run_once() is False

    async def boom(*a):
        raise RuntimeError("node down")

    node.claim_embedding = boom
    assert await w.run_once() is False


async def test_logs_contain_ids_codes_and_counts_only(caplog):
    caplog.set_level(logging.DEBUG)
    p = FakeProvider()
    chunks = [{"index": 0, "text": SECRET, "textHash": sha(SECRET)}]
    w, node, p, store = setup([embed_job(p.space_id)], {(ORG_A, DOC, 1): chunks}, provider=p)
    await w.run_once()
    assert "job=j1" in caplog.text and "outcome=embedded" in caplog.text
    assert "BOARD" not in caplog.text and "salary" not in caplog.text


# ---- settings and startup -------------------------------------------------------------------------------------------------------

def _key():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    return ec.generate_private_key(ec.SECP256R1()).private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()


def test_settings_defaults_and_validation():
    env = {"AI_WORKER_SIGNING_KEY": _key()}
    s = load_embedding_worker_settings(env)
    assert s.embedding.provider == "fastembed" and s.vectorstore.mode == "embedded" and s.ingestion_pipeline == "p2"
    for bad, msg in (({"AI_EMBEDDING_PROVIDER": "openai"}, "fastembed"), ({"AI_EMBEDDING_BATCH_SIZE": "0"}, "range"), ({"AI_EMBEDDING_PAGE_SIZE": "9999"}, "range")):
        with pytest.raises(ConfigError, match=msg):
            load_embedding_worker_settings({**env, **bad})
    with pytest.raises(ConfigError, match="signing key"):
        load_embedding_worker_settings({})


def test_the_fake_provider_is_refused_in_production():
    with pytest.raises(ConfigError, match="tests only"):
        load_embedding_worker_settings({"AI_WORKER_SIGNING_KEY": _key(), "AI_EMBEDDING_PROVIDER": "fake", "AI_ENVIRONMENT": "production", "QDRANT_URL": "https://q:6333", "QDRANT_API_KEY": "k"})


def test_the_worker_holds_no_groq_key_or_database_settings():
    import dataclasses

    names = {f.name for f in dataclasses.fields(EmbeddingWorkerSettings)}
    assert not {n for n in names if "groq" in n.lower() or "mongo" in n.lower() or "database" in n.lower()}


async def test_startup_fails_fast_when_the_model_cannot_load(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_WORKER_SIGNING_KEY", _key())
    monkeypatch.setenv("AI_EMBEDDING_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("AI_EMBEDDING_OFFLINE", "true")  # nothing cached, no network allowed
    monkeypatch.setenv("QDRANT_PATH", str(tmp_path / "q"))
    assert await _main(once=True) == 2


async def test_startup_fails_fast_when_the_vector_store_is_unreachable(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_WORKER_SIGNING_KEY", _key())
    monkeypatch.setenv("AI_EMBEDDING_PROVIDER", "fake")
    monkeypatch.setenv("QDRANT_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("QDRANT_TIMEOUT_SECONDS", "2")
    assert await _main(once=True) == 2
