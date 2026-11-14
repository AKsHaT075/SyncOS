import json
import shutil
import time
from pathlib import Path

import numpy as np
import pytest

from app.embeddings.factory import get_provider, reset_providers
from app.embeddings.fake_provider import FakeProvider
from app.embeddings.fastembed_provider import EmbeddingConfig, FastEmbedProvider, snapshot_dir, validate_output
from app.embeddings.provider import BadOutput, InputTooLong, ModelUnavailable
from app.embeddings.spec import E5_SMALL, EMBEDDING_PIPELINE, FAKE, SPECS, canonical, space_id

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "contracts" / "embedding.json").read_text())
CORPUS = json.loads((Path(__file__).resolve().parent / "eval" / "multilingual_corpus.json").read_text())


# ---- the embedding SPACE ---------------------------------------------------------------------------------------------

def test_space_ids_match_the_shared_golden_values():
    for key, spec in SPECS.items():
        golden = CONTRACT["spaces"][key]
        assert spec.descriptor(CONTRACT["ingestionPipeline"]) == golden["descriptor"]
        assert space_id(spec.descriptor("p2")) == golden["spaceId"]
    assert CONTRACT["embeddingPipeline"] == EMBEDDING_PIPELINE


@pytest.mark.parametrize(
    "field,value",
    [
        ("model", "other/model"), ("revision", "deadbeef"), ("modelFile", "onnx/model_O4.onnx"), ("dimensions", 768),
        ("pooling", "cls"), ("normalize", False), ("queryPrefix", ""), ("passagePrefix", ""), ("maxTokens", 256),
        ("distance", "dot"), ("embeddingPipeline", "e2"), ("ingestionPipeline", "p3"), ("provider", "other"),
    ],
)
def test_any_change_to_the_descriptor_is_a_different_space(field, value):
    d = E5_SMALL.descriptor("p2")
    changed = {**d, field: value}
    assert changed != d and space_id(changed) != space_id(d)


def test_the_fake_and_the_real_model_can_never_share_a_space():
    assert space_id(FAKE.descriptor("p2")) != space_id(E5_SMALL.descriptor("p2"))
    assert FakeProvider().space_id == CONTRACT["spaces"]["fake-hash-384"]["spaceId"]


def test_canonical_form_is_stable():
    assert canonical({"b": 1, "a": [True, "é"]}) == '{"a":[true,"é"],"b":1}'


def test_the_e5_prefixes_and_pooling_are_the_documented_ones():
    assert (E5_SMALL.query_prefix, E5_SMALL.passage_prefix) == ("query: ", "passage: ")
    assert (E5_SMALL.pooling, E5_SMALL.normalize, E5_SMALL.dimensions, E5_SMALL.max_tokens) == ("mean", True, 384, 512)
    assert E5_SMALL.revision == "614241f622f53c4eeff9890bdc4f31cfecc418b3"  # pinned: a moving revision would silently change vectors


# ---- the fake provider honours the same contract --------------------------------------------------------------------

def test_fake_dimensions_dtype_and_normalization():
    p = FakeProvider()
    v = p.embed_passages(["alpha beta", "gamma", "delta epsilon zeta"])
    assert v.shape == (3, 384) and v.dtype == np.float32
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)
    assert p.embed_passages([]).shape == (0, 384)
    assert p.embed_query("alpha").shape == (384,)


def test_fake_is_deterministic_and_similarity_is_meaningful():
    p = FakeProvider()
    a1, a2 = p.embed_passages(["annual leave policy days"]), p.embed_passages(["annual leave policy days"])
    assert np.array_equal(a1, a2)
    near = float(p.embed_query("annual leave days") @ p.embed_passages(["annual leave policy days"])[0])
    far = float(p.embed_query("annual leave days") @ p.embed_passages(["quarterly budget revenue forecast"])[0])
    assert near > far + 0.2


def test_fake_applies_different_prefixes_to_queries_and_passages():
    p = FakeProvider()
    assert not np.array_equal(p.embed_query("same text"), p.embed_passages(["same text"])[0])


def test_inputs_longer_than_the_window_fail_instead_of_being_truncated():
    p = FakeProvider(max_tokens=20)
    with pytest.raises(InputTooLong):
        p.embed_passages([" ".join(["word"] * 60)])
    assert p.calls == 1 and p.embed_passages(["short text"]).shape == (1, 384)


def test_initialization_failure_is_typed():
    with pytest.raises(ModelUnavailable):
        FakeProvider(fail_init=True)


@pytest.mark.parametrize("mode", ["nan", "shape", "norm"])
def test_malformed_model_output_is_rejected(mode):
    p = FakeProvider()
    p.corrupt_output = mode
    with pytest.raises(BadOutput):
        p.embed_passages(["some text here"])


def test_validate_output_is_strict():
    ok = np.eye(2, 4, dtype=np.float32)
    assert validate_output(ok, 2, 4) is ok
    for bad in (np.zeros((2, 3), np.float32), ok * 2, np.full((2, 4), np.inf, np.float32), np.zeros(4, np.float32)):
        with pytest.raises(BadOutput):
            validate_output(bad, 2, 4)


def test_errors_never_carry_input_text():
    p = FakeProvider(max_tokens=3)
    try:
        p.embed_passages(["TOP-SECRET " * 30])
    except InputTooLong as error:
        assert "SECRET" not in repr(error) + str(error)


def test_provider_is_loaded_once_per_process():
    reset_providers()
    from app.embeddings.fastembed_provider import EmbeddingConfig as C

    a, b = get_provider(C(provider="fake")), get_provider(C(provider="fake"))
    assert a is b
    reset_providers()
    with pytest.raises(ModelUnavailable):
        get_provider(C(provider="nope"))


# ---- failure handling of the REAL model loader (no heavy model needed) -----------------------------------------------

def test_offline_with_an_empty_cache_is_a_typed_failure(tmp_path):
    with pytest.raises(ModelUnavailable):
        snapshot_dir(E5_SMALL, EmbeddingConfig(cache_dir=str(tmp_path), offline=True))


def test_incomplete_snapshot_is_refused(tmp_path):
    (tmp_path / "config.json").write_text('{"hidden_size": 384}')
    with pytest.raises(ModelUnavailable):
        snapshot_dir(E5_SMALL, EmbeddingConfig(model_path=str(tmp_path)))


def test_loading_errors_do_not_leak_paths_or_content(tmp_path, caplog):
    import logging

    caplog.set_level(logging.DEBUG)
    with pytest.raises(ModelUnavailable) as e:
        FastEmbedProvider(config=EmbeddingConfig(cache_dir=str(tmp_path), offline=True))
    assert str(tmp_path) not in caplog.text and str(tmp_path) not in repr(e.value)


# ---- the REAL model (multilingual-e5-small, cached) ------------------------------------------------------------------

@pytest.fixture(scope="module")
def real(tokenizer_path):
    return get_provider(EmbeddingConfig(offline=True))


@pytest.fixture(scope="module")
def snapshot(tokenizer_path):
    return Path(tokenizer_path).parent


def test_real_model_dimensions_dtype_normalization_and_identity(real):
    assert real.space_id == CONTRACT["spaces"]["multilingual-e5-small"]["spaceId"]
    v = real.embed_passages(["Annual leave is 24 days.", "वार्षिक छुट्टी 24 दिन की है।", "ਸਾਲਾਨਾ ਛੁੱਟੀ 24 ਦਿਨ ਦੀ ਹੈ।"])
    assert v.shape == (3, 384) and v.dtype == np.float32
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-4)
    assert np.isfinite(v).all()


def test_real_model_is_deterministic_and_batch_invariant(real):
    texts = [row["passage"] for row in CORPUS["languages"]["en"]]
    batch = real.embed_passages(texts)
    again = real.embed_passages(texts)
    single = np.stack([real.embed_passages([t])[0] for t in texts])
    assert np.allclose(batch, again, atol=1e-6)
    assert np.allclose(batch, single, atol=1e-4)  # padding in a batch must not change a vector


def test_real_model_prefixes_matter(real, snapshot):
    text = "How many days of paid leave do I get?"
    with_prefix = real.embed_query(text)
    raw = np.asarray(list(real._model.embed([text])), dtype=np.float32)[0]  # no prefix at all
    assert float(with_prefix @ raw) < 0.999  # the "query: " prefix really changes the vector
    assert float(real.embed_query(text) @ real.embed_passages([text])[0]) < 0.999  # and so does query-vs-passage


def test_real_model_similarity_ordering_per_language(real):
    for lang in ("en", "hi", "pa"):
        rows = CORPUS["languages"][lang]
        passages = real.embed_passages([r["passage"] for r in rows])
        right = 0
        for i, r in enumerate(rows):
            scores = passages @ real.embed_query(r["query"])
            right += int(np.argmax(scores) == i)
        floor = {"en": 6, "pa": 5, "hi": 4}[lang]  # measured: en 6/6, pa 6/6, hi 5/6 (small sample - a smoke test, not a benchmark)
        assert right >= floor, (lang, right)


def test_real_model_cross_lingual_retrieval(real):
    hi = real.embed_passages([r["passage"] for r in CORPUS["languages"]["hi"]])
    hits = sum(int(np.argmax(hi @ real.embed_query(r["query"])) == i) for i, r in enumerate(CORPUS["languages"]["en"]))
    assert hits >= 4  # an English question finds the Hindi passage on the same topic


def test_real_model_counts_tokens_the_way_it_will_see_them(real):
    text = "Annual leave is 24 days."
    counted = real.count_tokens([text])[0]
    assert counted == len(real._tokenizer.encode("passage: " + text).ids)  # prefix AND <s></s> are included, exactly as the model sees it
    assert counted > len(real._tokenizer.encode(text, add_special_tokens=False).ids)


def test_real_model_refuses_to_truncate(real):
    too_long = " ".join(["policy"] * 700)
    assert real.count_tokens([too_long])[0] > 512
    with pytest.raises(InputTooLong):
        real.embed_passages([too_long])
    exactly_fits = " ".join(["policy"] * 400)
    assert real.embed_passages([exactly_fits]).shape == (1, 384)


def test_real_model_loads_once_and_is_then_fast(real):
    t = time.perf_counter()
    again = get_provider(EmbeddingConfig(offline=True))
    assert again is real and time.perf_counter() - t < 0.05


def test_real_model_corrupt_onnx_is_a_typed_failure(snapshot, tmp_path):
    for rel in E5_SMALL.files:
        dest = tmp_path / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel == "onnx/model.onnx":
            dest.write_bytes(b"this is not an onnx file")
        else:
            shutil.copy(snapshot / rel, dest)
    with pytest.raises(ModelUnavailable):
        FastEmbedProvider(config=EmbeddingConfig(model_path=str(tmp_path)))


def test_real_model_wrong_dimensions_on_disk_is_refused(snapshot, tmp_path):
    for rel in E5_SMALL.files:
        dest = tmp_path / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(snapshot / rel, dest)
    (tmp_path / "config.json").write_text('{"hidden_size": 768}')  # files do not describe the model we pinned
    with pytest.raises(ModelUnavailable):
        FastEmbedProvider(config=EmbeddingConfig(model_path=str(tmp_path)))


def test_real_model_ingestion_chunks_always_embed(real, tokenizer_path):
    """End to end of the sizing guarantee: whatever the p2 chunker emits, the embedder accepts (no InputTooLong)."""
    from app.ingestion.chunker import chunk_blocks
    from app.ingestion.limits import Limits
    from app.ingestion.model import Block
    from app.ingestion.sizer import TokenizerSizer

    sizer = TokenizerSizer(tokenizer_path)
    for lang in ("en", "hi", "pa"):
        text = " ".join(r["passage"] for r in CORPUS["languages"][lang] * 30)
        chunks = chunk_blocks([Block(text=text, loc={"charStart": 0, "charEnd": len(text)})], Limits(), sizer)
        vectors = real.embed_passages([c.text for c in chunks])
        assert vectors.shape == (len(chunks), 384)
