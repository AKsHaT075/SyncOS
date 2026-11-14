"""Maps an OpenAI-compatible HTTP failure to a normalized error. Only machine-readable
`code`/`type` and a few keywords are inspected; upstream message text is never kept."""
from __future__ import annotations

import re
from typing import Mapping

from ..core import errors as E
from ..core.errors import ProviderError


def parse_retry_after(headers: Mapping[str, str] | None) -> int | None:
    raw = (headers or {}).get("retry-after")
    if not raw:
        return None
    try:
        return max(0, round(float(raw) * 1000))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        import time

        return max(0, int((parsedate_to_datetime(raw).timestamp() - time.time()) * 1000))
    except Exception:
        return None


_CONTEXT = re.compile(r"context[_ ]length|maximum context|too many tokens|reduce the length")
_TOOL = re.compile(r"tool_use_failed|failed to call a function|invalid.*tool")
_FILTER = re.compile(r"content[_ ]filter|content_policy|safety")


def from_http_response(status: int, payload, headers: Mapping[str, str] | None = None) -> ProviderError:
    err = payload.get("error") if isinstance(payload, dict) else None
    err = err if isinstance(err, dict) else {}
    text = f"{err.get('code') or ''} {err.get('type') or ''} {err.get('message') or ''}".lower()
    raw_code = err.get("code")
    code = raw_code if isinstance(raw_code, str) and re.fullmatch(r"[a-z0-9_]{1,40}", raw_code) else None
    base = {"upstream_status": status, "retry_after_ms": parse_retry_after(headers), "upstream_code": code}

    if status in (401, 403):
        return ProviderError(E.AUTH, **base)
    if status == 429:
        return ProviderError(E.RATE_LIMITED, retryable=True, **base)
    if status == 413 or _CONTEXT.search(text):
        return ProviderError(E.CONTEXT_TOO_LONG, **base)
    if _TOOL.search(text):
        return ProviderError(E.TOOL_ERROR, **base)
    if _FILTER.search(text):
        return ProviderError(E.CONTENT_FILTERED, **base)
    if status == 408 or status >= 500:
        return ProviderError(E.UNAVAILABLE, retryable=True, **base)
    if status >= 400:
        return ProviderError(E.BAD_REQUEST, **base)
    return ProviderError(E.INVALID_RESPONSE, **base)
