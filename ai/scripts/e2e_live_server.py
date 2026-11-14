"""TEST-ONLY launcher for the Phase 8 Step 8 live-Groq end-to-end run. NOT used in production and not imported by the app.

The real Python AI service (create_app, real GroqProvider, real tool loop), except that every Groq call is spaced at least GAP seconds apart,
because the key has per-minute token limits and each call carries ~1.7k tokens of tool definitions. Started by backend/tests/e2e through a shell
that sources the gitignored ai/.env, so the key is only ever in THIS process's environment.

    python scripts/e2e_live_server.py            (reads HOST/PORT and the usual AI_* / GROQ_* variables from the environment)
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from app.core.config import load_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.providers.groq import GroqProvider  # noqa: E402

GAP = float(os.environ.get("E2E_GROQ_GAP_SECONDS", "20"))


class ThrottledGroq(GroqProvider):
    _last = 0.0

    async def chat(self, **kw):
        wait = GAP - (time.monotonic() - self._last)
        if wait > 0 and self._last:
            await asyncio.sleep(wait)
        try:
            async for event in super().chat(**kw):
                yield event
        finally:
            self._last = time.monotonic()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")  # per-round counts (never content) so the run can show what Groq actually returned
    settings = load_settings()

    async def log_provider_error(response: httpx.Response) -> None:
        # TEST-ONLY diagnostics: Groq's error status and body (the model's failed attempt on FAKE data; the request, and so the key, is never logged)
        if response.status_code >= 400:
            await response.aread()
            logging.getLogger("e2e.groq").warning("groq error status=%s body=%s", response.status_code, response.text[:900].replace("\n", " "))

    import app.providers.groq as groq_module  # TEST-ONLY: also log errors that arrive INSIDE a 200 stream (that is how tool_use_failed comes)

    original = groq_module.from_http_response

    def logging_mapper(status, payload, headers=None):
        logging.getLogger("e2e.groq").warning("groq error status=%s payload=%s", status, str(payload)[:1200].replace("\n", " "))
        return original(status, payload, headers)

    groq_module.from_http_response = logging_mapper
    http = httpx.AsyncClient(timeout=None, event_hooks={"response": [log_provider_error]})
    app = create_app(settings, provider=ThrottledGroq(settings, http=http))
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
