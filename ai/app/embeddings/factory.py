"""One provider instance per process. The model is loaded once, here, and reused for every job and request."""
from __future__ import annotations

import threading

from .fake_provider import FakeProvider
from .fastembed_provider import EmbeddingConfig, FastEmbedProvider
from .provider import EmbeddingProvider, ModelUnavailable

_lock = threading.Lock()
_cache: dict[tuple, EmbeddingProvider] = {}


def get_provider(config: EmbeddingConfig | None = None, ingestion_pipeline: str = "p2") -> EmbeddingProvider:
    config = config or EmbeddingConfig()
    key = (config.provider, config.cache_dir, config.model_path, config.threads, config.batch_size, config.offline, ingestion_pipeline)
    with _lock:
        provider = _cache.get(key)
        if provider is None:
            if config.provider == "fastembed":
                provider = FastEmbedProvider(config=config, ingestion_pipeline=ingestion_pipeline)
            elif config.provider == "fake":
                provider = FakeProvider(ingestion_pipeline=ingestion_pipeline)
            else:
                raise ModelUnavailable()
            _cache[key] = provider
        return provider


def reset_providers() -> None:  # tests
    with _lock:
        for p in _cache.values():
            p.close()
        _cache.clear()
