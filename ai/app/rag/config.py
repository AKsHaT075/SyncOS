from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from ..core.config import ConfigError
from ..embeddings.fastembed_provider import EmbeddingConfig
from ..vectorstore.config import VectorStoreConfig, load_vectorstore_config


@dataclass(frozen=True)
class RagSettings:
    enabled: bool = False
    node_url: str = "http://127.0.0.1:5002"
    top_k: int = 6  # sources given to the model
    candidates: int = 24  # first search size
    max_candidates: int = 200  # widest search (used when many hits turn out to be unauthorized)
    min_score: float = 0.81  # cosine floor (calibrated for multilingual-e5-small; recalibrate per model): below it a hit is never even sent to Node, let alone to the model
    score_window: float = 0.05  # keep hits within this distance of the best AUTHORIZED hit
    context_tokens: int = 3000  # budget for all sources together
    max_per_document: int = 3
    near_duplicate: float = 0.70  # word-set Jaccard at or above which two chunks count as the same passage (a copy with a few words changed scores ~0.85; distinct documents <= ~0.2)
    authorize_timeout: float = 10.0
    max_question_chars: int = 2000
    authorize_batch: int = 50
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    vectorstore: VectorStoreConfig = field(default_factory=VectorStoreConfig)
    ingestion_pipeline: str = "p2"


def _num(env: Mapping[str, str], name: str, default, cast, lo, hi):
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = cast(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number") from None
    if not lo <= value <= hi:
        raise ConfigError(f"{name} is out of range")
    return value


def load_rag_settings(env: Mapping[str, str] | None = None) -> RagSettings:
    env = os.environ if env is None else env
    if env.get("AI_RAG_ENABLED", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return RagSettings(enabled=False)
    provider = env.get("AI_EMBEDDING_PROVIDER", "").strip().lower() or "fastembed"
    if provider not in {"fastembed", "fake"}:
        raise ConfigError("AI_EMBEDDING_PROVIDER must be 'fastembed' or 'fake'")
    if provider == "fake" and env.get("AI_ENVIRONMENT", "").strip().lower() == "production":
        raise ConfigError("the fake embedding provider is for tests only and is refused in production")
    top_k = _num(env, "AI_RAG_TOP_K", 6, int, 1, 20)
    cands = _num(env, "AI_RAG_CANDIDATES", 24, int, 1, 200)
    maxc = _num(env, "AI_RAG_MAX_CANDIDATES", 200, int, cands, 1000)
    return RagSettings(
        enabled=True,
        node_url=(env.get("AI_NODE_INTERNAL_URL", "").strip() or "http://127.0.0.1:5002").rstrip("/"),
        top_k=top_k,
        candidates=cands,
        max_candidates=maxc,
        min_score=_num(env, "AI_RAG_MIN_SCORE", 0.81, float, 0.0, 1.0),
        score_window=_num(env, "AI_RAG_SCORE_WINDOW", 0.05, float, 0.0, 1.0),
        context_tokens=_num(env, "AI_RAG_CONTEXT_TOKENS", 3000, int, 200, 20000),
        max_per_document=_num(env, "AI_RAG_MAX_PER_DOCUMENT", 3, int, 1, 20),
        near_duplicate=_num(env, "AI_RAG_NEAR_DUPLICATE", 0.70, float, 0.3, 1.0),
        authorize_timeout=_num(env, "AI_RAG_AUTHORIZE_TIMEOUT_SECONDS", 10.0, float, 1.0, 60.0),
        max_question_chars=_num(env, "AI_RAG_MAX_QUESTION_CHARS", 2000, int, 20, 20000),
        embedding=EmbeddingConfig(
            provider=provider,
            cache_dir=env.get("AI_EMBEDDING_CACHE_DIR", "").strip() or None,
            offline=env.get("AI_EMBEDDING_OFFLINE", "").strip().lower() in {"1", "true", "yes"},
            threads=_num(env, "AI_EMBEDDING_THREADS", 0, int, 0, 256) or None,
            batch_size=_num(env, "AI_EMBEDDING_BATCH_SIZE", 16, int, 1, 256),
            model_path=env.get("AI_EMBEDDING_MODEL_PATH", "").strip() or None,
        ),
        vectorstore=load_vectorstore_config(env),
    )
