"""Node's answers are untrusted INPUT to Python. This module decides what of a tool result may reach the model."""
from __future__ import annotations

import json
import math
import re
from typing import Any

from ..rag.prompt import neutralize

MAX_DEPTH = 6
MAX_STRING = 1_000
MAX_ITEMS = 100
_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")  # rejects `$op`, `a.b`, `_id`, `__v` by construction
_FORBIDDEN = {"password", "passwordhash", "token", "accesstoken", "refreshtoken", "secret", "email", "apikey", "keyreference", "authorization"}


class ResultInvalid(Exception):
    """The result is not something we will show a model. Carries no content."""


def _clean_string(value: str) -> str:
    if len(value) > MAX_STRING:
        raise ResultInvalid
    # Data, not markup: no tag can survive into the prompt, and our own delimiters and chat-template tokens are neutralized.
    return neutralize(value).replace("<", "‹").replace(">", "›")


def _walk(value: Any, depth: int) -> Any:
    if depth > MAX_DEPTH:
        raise ResultInvalid
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ResultInvalid
        return value
    if isinstance(value, str):
        return _clean_string(value)
    if isinstance(value, list):
        if len(value) > MAX_ITEMS:
            raise ResultInvalid
        return [_walk(item, depth + 1) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if not isinstance(key, str) or not _KEY.match(key) or key.lower() in _FORBIDDEN:
                raise ResultInvalid
            out[key] = _walk(item, depth + 1)
        return out
    raise ResultInvalid


def sanitize_result(result: Any, *, max_bytes: int) -> dict:
    """A plain JSON OBJECT, bounded and cleaned; anything else is refused (never truncated or repaired)."""
    if not isinstance(result, dict):
        raise ResultInvalid
    clean = _walk(result, 1)
    if len(json.dumps(clean, separators=(",", ":"), ensure_ascii=False).encode()) > max_bytes:
        raise ResultInvalid
    return clean


def tool_message_ok(result: dict) -> str:
    return json.dumps({"status": "ok", "result": result}, separators=(",", ":"), ensure_ascii=False)


def tool_message_error(code: str, fields: list[str] | None = None) -> str:
    body: dict[str, Any] = {"status": "error", "error": code}
    if fields:
        body["invalidFields"] = fields
    return json.dumps(body, separators=(",", ":"))
