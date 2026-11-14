from __future__ import annotations

import asyncio
import threading

import httpx

from ..embeddings.factory import get_provider
from ..vectorstore.config import build_store
from .authorizer import NodeAuthorizer
from .config import RagSettings


class RagRuntime:
    """Process-wide retrieval resources. The embedding model and the vector-store client are created ONCE (lazily, off the
    event loop) and reused by every request; the HTTP client to Node is shared."""

    def __init__(self, settings: RagSettings, *, embedder=None, store=None, http: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._embedder, self._store = embedder, store
        self._lock = threading.Lock()
        self._http = http or httpx.AsyncClient(timeout=httpx.Timeout(settings.authorize_timeout, connect=3.0))
        self._owns_http = http is None

    def _build(self) -> None:
        with self._lock:
            if self._embedder is None:
                self._embedder = get_provider(self.settings.embedding, self.settings.ingestion_pipeline)
            if self._store is None:
                self._store = build_store(self.settings.vectorstore)

    async def ready(self):
        """(embedding provider, vector store); builds them on first use without blocking the event loop."""
        if self._embedder is None or self._store is None:
            await asyncio.to_thread(self._build)
        return self._embedder, self._store

    def authorizer(self, callback_token: str) -> NodeAuthorizer:
        return NodeAuthorizer(self._http, self.settings.node_url, callback_token, self.settings.authorize_timeout)

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()
