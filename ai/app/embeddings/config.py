"""Settings for the embedding worker (a separate process). It holds a Qdrant config and the worker's signing key,
and NO Groq key, NO database access."""
from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from typing import Mapping

from ..core.config import ConfigError
from ..ingestion import PIPELINE_VERSION as INGESTION_PIPELINE
from ..ingestion.config import load_signing_key_pem
from ..vectorstore.config import VectorStoreConfig, load_vectorstore_config
from .fastembed_provider import EmbeddingConfig


@dataclass(frozen=True)
class EmbeddingWorkerSettings:
    node_url: str = "http://127.0.0.1:5002"
    signing_key_pem: str = ""
    key_id: str = "w1"
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}-{os.getpid()}")
    poll_seconds: float = 3.0
    page_size: int = 64  # chunks fetched from Node per request
    batch_size: int = 16  # texts per model call
    ingestion_pipeline: str = INGESTION_PIPELINE
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    vectorstore: VectorStoreConfig = field(default_factory=VectorStoreConfig)


def _int(env: Mapping[str, str], name: str, default: int, minimum: int = 1, maximum: int = 10_000) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} is out of range")
    return value


def load_embedding_worker_settings(env: Mapping[str, str] | None = None) -> EmbeddingWorkerSettings:
    env = os.environ if env is None else env
    provider = (env.get("AI_EMBEDDING_PROVIDER", "").strip().lower() or "fastembed")
    if provider not in {"fastembed", "fake"}:
        raise ConfigError("AI_EMBEDDING_PROVIDER must be 'fastembed' or 'fake'")
    if provider == "fake" and env.get("AI_ENVIRONMENT", "").strip().lower() == "production":
        raise ConfigError("the fake embedding provider is for tests only and is refused in production")
    embedding = EmbeddingConfig(
        provider=provider,
        cache_dir=env.get("AI_EMBEDDING_CACHE_DIR", "").strip() or None,
        offline=env.get("AI_EMBEDDING_OFFLINE", "").strip().lower() in {"1", "true", "yes"},
        threads=_int(env, "AI_EMBEDDING_THREADS", 0, minimum=0, maximum=256) or None,
        batch_size=_int(env, "AI_EMBEDDING_BATCH_SIZE", 16, maximum=256),
        model_path=env.get("AI_EMBEDDING_MODEL_PATH", "").strip() or None,
    )
    return EmbeddingWorkerSettings(
        node_url=(env.get("AI_NODE_INTERNAL_URL", "").strip() or "http://127.0.0.1:5002").rstrip("/"),
        signing_key_pem=load_signing_key_pem(env),
        key_id=env.get("AI_WORKER_KEY_ID", "").strip() or "w1",
        worker_id=env.get("AI_WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        poll_seconds=float(_int(env, "AI_EMBEDDING_POLL_SECONDS", 3)),
        page_size=_int(env, "AI_EMBEDDING_PAGE_SIZE", 64, maximum=200),
        batch_size=embedding.batch_size,
        embedding=embedding,
        vectorstore=load_vectorstore_config(env),
    )
