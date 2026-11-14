"""One contract, four backends: in-memory reference, Qdrant :memory:, Qdrant embedded (on disk), and a REAL Qdrant server."""
import numpy as np
import pytest

from app.vectorstore.base import (
    DimensionMismatch, InvalidScope, InvalidVector, StoreUnavailable, VectorItem, point_id,
)
from app.vectorstore.config import VectorStoreConfig, load_vectorstore_config
from app.vectorstore.memory_store import MemoryStore
from app.vectorstore.qdrant_store import QdrantStore
from app.core.config import ConfigError
from tests.conftest import QDRANT_TEST_KEY

ORG_A, ORG_B = "a" * 24, "b" * 24
DOC1, DOC2 = "d1" + "0" * 22, "d2" + "0" * 22
SPACE, OTHER_SPACE = "abcdef123456", "123456abcdef"
PIPE = "p2"
DIMS = 8


def unit(seed: int, dims: int = DIMS) -> np.ndarray:
    v = np.random.default_rng(seed).standard_normal(dims).astype(np.float32)
    return v / np.linalg.norm(v)


def items(n, seed0=0, dims=DIMS, tag="h"):
    return [VectorItem(i, f"{tag}{i}", unit(seed0 + i, dims)) for i in range(n)]


@pytest.fixture(params=["memory", "qdrant-memory", "qdrant-embedded", "qdrant-server"])
def store(request, tmp_path):
    kind = request.param
    if kind == "memory":
        s = MemoryStore()
    elif kind == "qdrant-memory":
        s = QdrantStore(VectorStoreConfig(collection_prefix="t"))
    elif kind == "qdrant-embedded":
        s = QdrantStore(VectorStoreConfig(path=str(tmp_path / "q"), collection_prefix="t"))
    else:
        server = request.getfixturevalue("qdrant_server")
        import uuid

        s = QdrantStore(VectorStoreConfig(url=server["url"], api_key=server["api_key"], collection_prefix="t" + uuid.uuid4().hex[:8], timeout_seconds=5))
    s.ensure_collection(SPACE, DIMS)
    yield s
    try:
        s.drop_collection(SPACE)
        s.drop_collection(OTHER_SPACE)
    except Exception:
        pass
    s.close()


def put(s, org=ORG_A, doc=DOC1, version=1, its=None, space=SPACE):
    return s.upsert(organization=org, document=doc, version=version, ingestion_pipeline=PIPE, space_id=space, items=its if its is not None else items(3))


def count(s, org=ORG_A, doc=DOC1, version=None, space=SPACE):
    return s.count(organization=org, document=doc, space_id=space, version=version)


def hashes(s, org=ORG_A, doc=DOC1, version=1, space=SPACE):
    return s.indexed_hashes(organization=org, document=doc, version=version, ingestion_pipeline=PIPE, space_id=space)


# ---- insert / search / delete ----------------------------------------------------------------------------------------

def test_insert_and_read_back(store):
    assert put(store) == 3
    assert count(store) == 3 and hashes(store) == {0: "h0", 1: "h1", 2: "h2"}


def test_upsert_is_idempotent_and_updates_in_place(store):
    put(store)
    put(store)
    assert count(store) == 3  # same deterministic ids: no duplicates
    put(store, its=[VectorItem(1, "CHANGED", unit(99))])
    assert count(store) == 3 and hashes(store)[1] == "CHANGED"


def test_search_orders_by_similarity(store):
    its = items(5)
    put(store, its=its)
    hits = store.search(organization=ORG_A, space_id=SPACE, vector=its[3].vector, limit=3)
    assert [h.chunk_index for h in hits][0] == 3 and hits[0].score == pytest.approx(1.0, abs=1e-4)
    assert hits == sorted(hits, key=lambda h: -h.score)
    assert all(h.document == DOC1 and h.version == 1 for h in hits)


def test_search_can_be_limited_to_documents_node_authorized(store):
    put(store, doc=DOC1, its=items(2, 0))
    put(store, doc=DOC2, its=items(2, 50))
    v = unit(50)
    assert store.search(organization=ORG_A, space_id=SPACE, vector=v, limit=5, document_ids=[DOC1]) and all(h.document == DOC1 for h in store.search(organization=ORG_A, space_id=SPACE, vector=v, limit=5, document_ids=[DOC1]))
    assert {h.document for h in store.search(organization=ORG_A, space_id=SPACE, vector=v, limit=5)} == {DOC1, DOC2}
    assert store.search(organization=ORG_A, space_id=SPACE, vector=v, limit=5, document_ids=[]) == []  # an empty allow-list matches nothing


def test_delete_chunks_and_document_are_idempotent(store):
    put(store, version=1)
    put(store, version=2, its=items(2, 10))
    store.delete_chunks(organization=ORG_A, document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=SPACE, chunk_indexes=[1, 2])
    assert hashes(store, version=1) == {0: "h0"}
    store.delete_chunks(organization=ORG_A, document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=SPACE, chunk_indexes=[1, 2])  # again: no error
    store.delete_chunks(organization=ORG_A, document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=SPACE, chunk_indexes=[])
    assert store.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE, keep_version=2) == 1
    assert count(store, version=1) == 0 and count(store, version=2) == 2
    assert store.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE) == 2
    assert store.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE) == 0  # nothing left: still fine
    assert count(store) == 0


def test_deleting_from_a_space_that_was_never_created_is_a_noop(store):
    assert store.delete_document(organization=ORG_A, document=DOC1, space_id=OTHER_SPACE) == 0
    assert store.count(organization=ORG_A, document=DOC1, space_id=OTHER_SPACE) == 0
    assert store.indexed_hashes(organization=ORG_A, document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=OTHER_SPACE) == {}
    store.drop_collection(OTHER_SPACE)


# ---- isolation ----------------------------------------------------------------------------------------------------------

def test_organizations_cannot_see_or_touch_each_other(store):
    same = items(3)  # IDENTICAL vectors and identical document ids in both tenants
    put(store, org=ORG_A, its=same)
    put(store, org=ORG_B, its=same)
    assert count(store, org=ORG_A) == 3 and count(store, org=ORG_B) == 3
    assert {h.score for h in store.search(organization=ORG_A, space_id=SPACE, vector=same[0].vector, limit=50)} and len(store.search(organization=ORG_A, space_id=SPACE, vector=same[0].vector, limit=50)) == 3
    store.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE)
    assert count(store, org=ORG_A) == 0 and count(store, org=ORG_B) == 3  # deleting A's document left B's untouched
    store.delete_chunks(organization=ORG_A, document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=SPACE, chunk_indexes=[0, 1, 2])
    assert count(store, org=ORG_B) == 3
    assert hashes(store, org=ORG_A) == {} and len(hashes(store, org=ORG_B)) == 3


def test_point_ids_are_deterministic_and_tenant_specific():
    a = point_id(ORG_A, DOC1, 1, PIPE, 0)
    assert a == point_id(ORG_A, DOC1, 1, PIPE, 0)
    assert len({a, point_id(ORG_B, DOC1, 1, PIPE, 0), point_id(ORG_A, DOC2, 1, PIPE, 0), point_id(ORG_A, DOC1, 2, PIPE, 0), point_id(ORG_A, DOC1, 1, PIPE, 1), point_id(ORG_A, DOC1, 1, "p3", 0)}) == 6


@pytest.mark.parametrize("bad", ["", "short", "../../etc/passwd", "a b", "x" * 100, "ünïcode0123456789"])
def test_invalid_scope_ids_are_refused_before_any_io(store, bad):
    with pytest.raises(InvalidScope):
        store.count(organization=bad, document=DOC1, space_id=SPACE)
    with pytest.raises(InvalidScope):
        store.delete_document(organization=ORG_A, document=bad, space_id=SPACE)
    with pytest.raises(InvalidScope):
        put(store, org=bad)


def test_every_operation_requires_an_organization(store):
    for call in (
        lambda: store.count(document=DOC1, space_id=SPACE),
        lambda: store.delete_document(document=DOC1, space_id=SPACE),
        lambda: store.search(space_id=SPACE, vector=unit(1), limit=1),
        lambda: store.indexed_hashes(document=DOC1, version=1, ingestion_pipeline=PIPE, space_id=SPACE),
    ):
        with pytest.raises(TypeError):
            call()


def test_spaces_never_share_vectors(store):
    store.ensure_collection(OTHER_SPACE, DIMS)
    put(store, space=SPACE)
    assert count(store, space=SPACE) == 3 and count(store, space=OTHER_SPACE) == 0
    put(store, space=OTHER_SPACE, its=items(1, 77))
    store.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE)
    assert count(store, space=SPACE) == 0 and count(store, space=OTHER_SPACE) == 1


# ---- dimensions and vector validity ------------------------------------------------------------------------------------

def test_wrong_dimensions_are_rejected_before_anything_is_written(store):
    with pytest.raises(DimensionMismatch):
        put(store, its=items(2, dims=DIMS + 1))
    assert count(store) == 0
    with pytest.raises(DimensionMismatch):
        put(store, its=items(2) + items(1, dims=DIMS - 1))  # one bad vector poisons the whole batch: none are written
    assert count(store) == 0


def test_invalid_vectors_are_rejected(store):
    nan = unit(1)
    nan[0] = np.nan
    for bad in (nan, unit(1) * 3, np.zeros(DIMS, np.float32), np.full(DIMS, np.inf, np.float32)):
        with pytest.raises(InvalidVector):
            put(store, its=[VectorItem(0, "h", bad)])
    with pytest.raises(InvalidVector):
        put(store, its=[VectorItem(0, "h", np.ones((2, DIMS), np.float32))])
    assert count(store) == 0


def test_an_existing_collection_with_other_dimensions_is_never_written_to(store):
    with pytest.raises(DimensionMismatch):
        store.ensure_collection(SPACE, DIMS * 2)  # the collection for this space id disagrees with the space definition
    assert count(store) == 0
    put(store)  # and the original collection is still perfectly usable
    assert count(store) == 3


def test_search_with_a_wrong_sized_query_is_rejected(store):
    put(store)
    with pytest.raises(DimensionMismatch):
        store.search(organization=ORG_A, space_id=SPACE, vector=unit(1, DIMS + 3), limit=3)


def test_ensure_collection_is_idempotent(store):
    store.ensure_collection(SPACE, DIMS)
    store.ensure_collection(SPACE, DIMS)
    put(store)
    store.ensure_collection(SPACE, DIMS)
    assert count(store) == 3


# ---- Qdrant specifics ------------------------------------------------------------------------------------------------------

def test_payload_has_no_text_and_no_permissions(store):
    if not isinstance(store, QdrantStore):
        pytest.skip("payload layout is specific to the Qdrant adapter")
    put(store)
    records, _ = store._client.scroll(store._name(SPACE), limit=10, with_payload=True)
    assert records
    for r in records:
        assert set(r.payload) == {"organization", "document", "version", "chunk_index", "text_hash", "ingestion_pipeline", "space"}
        assert r.payload["organization"] == ORG_A and r.payload["space"] == SPACE
        assert str(r.id) == point_id(ORG_A, DOC1, 1, PIPE, r.payload["chunk_index"])


def test_server_collection_has_the_documented_schema(qdrant_server):
    import httpx as hx

    s = QdrantStore(VectorStoreConfig(url=qdrant_server["url"], api_key=qdrant_server["api_key"], collection_prefix="schema"))
    s.ensure_collection(SPACE, 384)
    info = hx.get(f"{qdrant_server['url']}/collections/schema_{SPACE}", headers={"api-key": QDRANT_TEST_KEY}).json()["result"]
    assert info["config"]["params"]["vectors"] == {"size": 384, "distance": "Cosine", "on_disk": False} or (info["config"]["params"]["vectors"]["size"] == 384 and info["config"]["params"]["vectors"]["distance"] == "Cosine")
    schema = info["payload_schema"]
    assert schema["organization"]["data_type"] == "keyword" and schema["document"]["data_type"] == "keyword" and schema["version"]["data_type"] == "integer"
    s.drop_collection(SPACE)


def test_unreachable_server_is_a_typed_failure_for_every_operation():
    s = QdrantStore.__new__(QdrantStore)  # a client pointed at a port nobody listens on
    from qdrant_client import QdrantClient

    s.config, s.prefix = VectorStoreConfig(url="http://127.0.0.1:9", collection_prefix="x"), "x"
    s._client = QdrantClient(url="http://127.0.0.1:9", timeout=2, check_compatibility=False)
    assert s.health() is False
    for call in (
        lambda: s.ensure_collection(SPACE, DIMS),
        lambda: put(s),
        lambda: s.count(organization=ORG_A, document=DOC1, space_id=SPACE),
        lambda: s.delete_document(organization=ORG_A, document=DOC1, space_id=SPACE),
        lambda: s.search(organization=ORG_A, space_id=SPACE, vector=unit(1), limit=1),
    ):
        with pytest.raises(StoreUnavailable):
            call()


def test_wrong_api_key_is_reported_as_an_auth_failure_without_the_key(qdrant_server, caplog):
    import logging

    caplog.set_level(logging.DEBUG)
    s = QdrantStore(VectorStoreConfig(url=qdrant_server["url"], api_key="wrong-key-value", collection_prefix="auth"))
    with pytest.raises(StoreUnavailable) as e:
        s.ensure_collection(SPACE, DIMS)
    assert e.value.code in {"VECTOR_STORE_AUTH", "VECTOR_STORE_UNAVAILABLE"}
    assert "wrong-key-value" not in caplog.text and QDRANT_TEST_KEY not in caplog.text
    no_key = QdrantStore(VectorStoreConfig(url=qdrant_server["url"], api_key=None, collection_prefix="auth"))
    with pytest.raises(StoreUnavailable):
        no_key.ensure_collection(SPACE, DIMS)  # the server really enforces authentication


def test_server_outage_mid_operation_is_a_typed_failure(qdrant_server, tmp_path):
    import os
    import subprocess

    from tests.conftest import QDRANT_BIN, _free_port

    http = _free_port()
    env = {"PATH": os.environ["PATH"], "QDRANT__SERVICE__HOST": "127.0.0.1", "QDRANT__SERVICE__HTTP_PORT": str(http), "QDRANT__SERVICE__GRPC_PORT": str(_free_port()), "QDRANT__STORAGE__STORAGE_PATH": str(tmp_path / "s"), "QDRANT__STORAGE__SNAPSHOTS_PATH": str(tmp_path / "sn"), "QDRANT__TELEMETRY_DISABLED": "true"}
    proc = subprocess.Popen([str(QDRANT_BIN)], cwd=tmp_path, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import time

    import httpx as hx

    for _ in range(100):
        try:
            if hx.get(f"http://127.0.0.1:{http}/healthz", timeout=1).status_code == 200:
                break
        except hx.HTTPError:
            time.sleep(0.2)
    s = QdrantStore(VectorStoreConfig(url=f"http://127.0.0.1:{http}", collection_prefix="out", timeout_seconds=3))
    s.ensure_collection(SPACE, DIMS)
    put(s)
    proc.kill()
    proc.wait()
    with pytest.raises(StoreUnavailable):
        put(s)
    assert s.health() is False


def test_embedded_mode_is_single_process(tmp_path):
    first = QdrantStore(VectorStoreConfig(path=str(tmp_path / "q")))
    with pytest.raises(StoreUnavailable):
        QdrantStore(VectorStoreConfig(path=str(tmp_path / "q")))  # a second process/instance on the same path is refused
    first.close()
    QdrantStore(VectorStoreConfig(path=str(tmp_path / "q"))).close()


def test_embedded_mode_survives_a_restart(tmp_path):
    s = QdrantStore(VectorStoreConfig(path=str(tmp_path / "q"), collection_prefix="t"))
    s.ensure_collection(SPACE, DIMS)
    put(s)
    s.close()
    again = QdrantStore(VectorStoreConfig(path=str(tmp_path / "q"), collection_prefix="t"))
    again.ensure_collection(SPACE, DIMS)
    assert count(again) == 3
    again.close()


# ---- configuration safety ----------------------------------------------------------------------------------------------------

def test_development_default_is_embedded_and_documented_as_single_process():
    c = load_vectorstore_config({})
    assert c.mode == "embedded" and c.path and c.url is None


@pytest.mark.parametrize(
    "env,message",
    [
        ({"AI_ENVIRONMENT": "production"}, "development-only"),
        ({"AI_ENVIRONMENT": "production", "QDRANT_PATH": "/data"}, "development-only"),
        ({"AI_ENVIRONMENT": "production", "QDRANT_URL": "http://qdrant.internal:6333", "QDRANT_API_KEY": "k"}, "https"),
        ({"AI_ENVIRONMENT": "production", "QDRANT_URL": "https://qdrant.internal:6333"}, "QDRANT_API_KEY"),
        ({"QDRANT_URL": "http://10.0.0.5:6333"}, "QDRANT_API_KEY"),
        ({"QDRANT_URL": "http://10.0.0.5:6333", "QDRANT_API_KEY": "k"}, "https"),
        ({"QDRANT_URL": "ftp://x"}, "http"),
        ({"QDRANT_COLLECTION_PREFIX": "bad-prefix!"}, "PREFIX"),
        ({"QDRANT_TIMEOUT_SECONDS": "soon"}, "number"),
    ],
)
def test_unsafe_configurations_are_refused(env, message):
    with pytest.raises(ConfigError, match=message):
        load_vectorstore_config(env)


@pytest.mark.parametrize(
    "env",
    [
        {"QDRANT_URL": "http://127.0.0.1:6333"},
        {"QDRANT_URL": "http://localhost:6333"},
        {"QDRANT_URL": "https://qdrant.internal:6333", "QDRANT_API_KEY": "k"},
        {"AI_ENVIRONMENT": "production", "QDRANT_URL": "https://qdrant.internal:6333", "QDRANT_API_KEY": "k"},
        {"QDRANT_PATH": "/tmp/q"},
    ],
)
def test_safe_configurations_are_accepted(env):
    load_vectorstore_config(env)


def test_the_api_key_is_never_part_of_the_config_repr():
    c = load_vectorstore_config({"QDRANT_URL": "https://q.internal:6333", "QDRANT_API_KEY": "super-secret-key"})
    assert c.api_key == "super-secret-key"  # held for the client...
    from dataclasses import fields

    assert "api_key" in {f.name for f in fields(c)}
