"""Retrieval evaluation as regression tests: REAL multilingual-e5-small, real vector store, the real retrieve()/select() code.
Gates sit a little below the measured values (printed by scripts/evaluate_retrieval.py) so a regression is caught without flaking."""
import dataclasses

import pytest

from app.embeddings.factory import get_provider
from app.embeddings.fastembed_provider import EmbeddingConfig
from app.rag.config import RagSettings
from app.vectorstore.config import VectorStoreConfig
from app.vectorstore.qdrant_store import QdrantStore
from tests.rag_eval import evaluate


@pytest.fixture(scope="module")
def result(tokenizer_path):
    provider = get_provider(EmbeddingConfig(offline=True))
    return evaluate(provider, QdrantStore(VectorStoreConfig(collection_prefix="evalgate")))


def test_defaults_are_the_calibrated_ones():
    c = RagSettings()
    assert (c.min_score, c.score_window, c.top_k, c.context_tokens, c.near_duplicate) == (0.81, 0.05, 6, 3000, 0.70)


def test_ranking_quality_per_language(result):
    r = result["rank"]
    assert r["all"]["mrr"] >= 0.95 and r["all"]["hit@1"] >= 0.92 and r["all"]["hit@3"] >= 0.98
    assert r["all"]["recall@5"] >= 0.93
    for lang in ("en", "hi", "pa"):  # measured: en 1.0, hi 0.9 (the known weakest), pa 1.0
        assert r[lang]["hit@3"] >= 0.95, lang
        assert r[lang]["mrr"] >= 0.88, lang
    assert r["en"]["precision@1"] >= 0.95 and r["hi"]["precision@1"] >= 0.85


def test_cross_language_retrieval(result):
    # Hindi/Punjabi questions about topics that only have an ENGLISH document
    assert result["cross"]["questions"] == 8
    assert result["cross"]["hit@3"] >= 0.95


def test_context_quality(result):
    c = result["context"]
    assert c["answer_bearing_context_rate"] >= 0.94  # measured 0.971 (34 answerable questions; one Hindi question below the floor)
    assert c["false_no_answer"] <= 2
    assert c["context_precision"] >= 0.78
    assert c["budget_respected"] is True


def test_questions_without_an_answer_are_refused_not_guessed(result):
    na = result["no_answer"]
    assert na["questions"] == 9 and na["rate"] == 1.0  # including near-topical ones (pet policy, dress code) in all three languages


def test_unauthorized_trashed_and_stale_documents_never_reach_the_context(result):
    s = result["security"]
    assert s["forbidden_chunks_in_context"] == 0
    assert s["stale_version_chunks_in_context"] == 0
    assert s["current_version_found_for_stale_question"] >= 1  # the CURRENT version is used instead of the stale one
    assert s["unauthorized_questions_without_answer"] == "3/3"  # with the only matching documents denied, the answer is "not found"


def test_near_duplicate_chunks_are_not_given_to_the_model_twice(result):
    assert result["security"].get("near_duplicate_both_used", 0) == 0
    assert result["context"]["near_duplicates_dropped"] >= 1


def test_the_threshold_trades_recall_for_precision_in_the_documented_direction():
    from tests.rag_eval import sweep

    provider = get_provider(EmbeddingConfig(offline=True))
    rows = {r["min_score"]: r for r in sweep(provider, QdrantStore(VectorStoreConfig(collection_prefix="sweepgate")), thresholds=(0.76, 0.81, 0.86))}
    assert rows[0.76]["no_answer_refused"] < rows[0.81]["no_answer_refused"] == 1.0  # too low: unanswerable questions get context
    assert rows[0.86]["answerable_with_context"] < rows[0.81]["answerable_with_context"]  # too high: real answers are lost
    assert rows[0.86]["context_precision"] >= rows[0.81]["context_precision"] >= rows[0.76]["context_precision"]
