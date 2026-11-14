"""Vector store configuration. Qdrant is configured INDEPENDENTLY of everything else, and only the Python processes
ever hold these settings: Node, Next.js and the browser never have a Qdrant URL or key."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlparse

from ..core.config import ConfigError

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@dataclass(frozen=True)
class VectorStoreConfig:
    url: str | None = None  # a Qdrant server, e.g. https://qdrant.internal:6333 (production)
    api_key: str | None = None
    path: str | None = None  # embedded local mode (development default): single process only
    collection_prefix: str = "syncos_chunks"
    timeout_seconds: float = 10.0
    environment: str = "development"

    @property
    def mode(self) -> str:
        return "server" if self.url else ("embedded" if self.path else "memory")


def validate(config: VectorStoreConfig) -> VectorStoreConfig:
    """Refuses configurations that would weaken a security guarantee."""
    prod = config.environment == "production"
    if config.url:
        parsed = urlparse(config.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ConfigError("QDRANT_URL must be an http(s) URL")
        loopback = parsed.hostname in LOOPBACK
        if prod and (parsed.scheme != "https" or not config.api_key):
            raise ConfigError("production Qdrant requires https and QDRANT_API_KEY")
        if not loopback and not config.api_key:
            raise ConfigError("a non-loopback Qdrant needs QDRANT_API_KEY")
        if not loopback and parsed.scheme != "https":
            raise ConfigError("a non-loopback Qdrant needs https (an API key must not cross the network in clear text)")
    elif prod:
        raise ConfigError("embedded/in-memory Qdrant is single-process and development-only; production needs QDRANT_URL")
    if not config.collection_prefix.replace("_", "").isalnum():
        raise ConfigError("QDRANT_COLLECTION_PREFIX may contain letters, digits and underscores only")
    return config


def load_vectorstore_config(env: Mapping[str, str] | None = None) -> VectorStoreConfig:
    env = os.environ if env is None else env
    url = env.get("QDRANT_URL", "").strip() or None
    path = env.get("QDRANT_PATH", "").strip() or None
    if url is None and path is None:
        path = ".qdrant-data"  # development default: embedded, no server, no Docker (single process only)
    try:
        timeout = float(env.get("QDRANT_TIMEOUT_SECONDS", "").strip() or 10)
    except ValueError:
        raise ConfigError("QDRANT_TIMEOUT_SECONDS must be a number") from None
    return validate(
        VectorStoreConfig(
            url=url,
            api_key=env.get("QDRANT_API_KEY", "").strip() or None,
            path=None if url else path,
            collection_prefix=env.get("QDRANT_COLLECTION_PREFIX", "").strip() or "syncos_chunks",
            timeout_seconds=timeout,
            environment=(env.get("AI_ENVIRONMENT", "").strip().lower() or "development"),
        )
    )


def build_store(config: VectorStoreConfig):
    from .qdrant_store import QdrantStore

    return QdrantStore(config)
