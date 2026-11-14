"""Sync OS AI service (FastAPI). Internal only: Node is the sole client."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .api.routes import router
from .core.config import Settings, load_settings
from .core.replay import ReplayGuard, build_replay_guard
from .providers.groq import GroqProvider
from .rag.runtime import RagRuntime


def create_app(settings: Settings | None = None, *, provider: GroqProvider | None = None, replay: ReplayGuard | None = None, rag: RagRuntime | None = None, tool_http: httpx.AsyncClient | None = None) -> FastAPI:
    settings = settings or load_settings()
    provider = provider or GroqProvider(settings)
    replay = replay or build_replay_guard(settings)
    rag = rag or (RagRuntime(settings.rag) if settings.rag.enabled else None)
    owns_tool_http = tool_http is None
    tool_http = tool_http or httpx.AsyncClient(timeout=None, follow_redirects=False)  # callbacks to Node only; redirects are never followed

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await provider.close()
        await replay.close()
        if owns_tool_http:
            await tool_http.aclose()
        if rag is not None:
            await rag.close()

    # No /docs, /redoc or /openapi.json: an internal service has no reason to describe itself.
    app = FastAPI(title="syncos-ai", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.provider = provider
    app.state.replay = replay
    app.state.rag = rag
    app.state.tool_http = tool_http
    app.include_router(router)

    @app.exception_handler(Exception)
    async def unhandled(_, __):  # never leak a traceback or request content
        return JSONResponse({"error": {"code": "INTERNAL"}}, status_code=500)

    return app


def build() -> FastAPI:  # `uvicorn app.main:build --factory`
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return create_app()
