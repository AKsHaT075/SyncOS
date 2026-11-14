"""Asks NODE which retrieved chunks the current user may use, and receives their text only if they pass.

Python never decides access. The callback token it presents was minted by Node for THIS request only; Node verifies it,
requires the request to still be in flight, re-loads the user, re-runs the AI gate, and applies the document access rules.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Protocol, Sequence

import httpx

from ..vectorstore.base import Hit

log = logging.getLogger("ai.rag")


class AuthorizerError(Exception):
    """Node could not authorize (token refused, request over, Node down). Fail closed: no text, no answer."""

    def __init__(self, code: str = "AUTHORIZER_UNAVAILABLE") -> None:
        super().__init__(code)
        self.code = code


class Authorizer(Protocol):
    async def authorize(self, candidates: Sequence[Hit]) -> tuple[list[dict], int]:
        """Returns (authorized items with text, number rejected)."""


def key_of(document: str, version: int, chunk_index: int) -> tuple[str, int, int]:
    return (document, int(version), int(chunk_index))


class NodeAuthorizer:
    def __init__(self, http: httpx.AsyncClient, node_url: str, callback_token: str, timeout: float = 10.0) -> None:
        self._http, self._url, self._token, self._timeout = http, node_url, callback_token, timeout

    async def authorize(self, candidates: Sequence[Hit]) -> tuple[list[dict], int]:
        if not candidates:
            return [], 0
        body = {"candidates": [{"documentId": c.document, "version": c.version, "chunkIndex": c.chunk_index, "textHash": c.text_hash} for c in candidates]}
        try:
            response = await self._http.post(f"{self._url}/internal/ai/knowledge/authorize", json=body, headers={"Authorization": f"Bearer {self._token}"}, timeout=self._timeout)
        except httpx.HTTPError:
            raise AuthorizerError("AUTHORIZER_UNAVAILABLE") from None
        if response.status_code in (401, 403, 404, 409):
            raise AuthorizerError("AUTHORIZER_REFUSED")  # the token, the request or the user's access is gone
        if response.status_code != 200:
            raise AuthorizerError("AUTHORIZER_UNAVAILABLE")
        try:
            payload = response.json()
            items = payload["items"]
            assert isinstance(items, list)
        except Exception:
            raise AuthorizerError("AUTHORIZER_BAD_RESPONSE") from None
        return validate_items(candidates, items)


def validate_items(candidates: Sequence[Hit], items: list) -> tuple[list[dict], int]:
    """Defence in depth on Node's answer: only items we ASKED about, with text that matches the hash we asked about."""
    wanted = {key_of(c.document, c.version, c.chunk_index): c for c in candidates}
    good, seen = [], set()
    for item in items:
        try:
            key = key_of(item["documentId"], item["version"], item["chunkIndex"])
            text = item["text"]
            if key not in wanted or key in seen or not isinstance(text, str) or not text:
                continue
            expected = wanted[key].text_hash
            if item["textHash"] != expected or hashlib.sha256(text.encode("utf-8")).hexdigest() != expected:
                continue  # not the chunk the vector was made from: stale or tampered
            if not isinstance(item["chunkId"], str) or not isinstance(item["documentName"], str) or not isinstance(item.get("location", {}), dict):
                continue
            tokens = item.get("tokens")
            good.append({**item, "tokens": int(tokens) if isinstance(tokens, int) and tokens > 0 else max(1, len(text) // 3)})
            seen.add(key)
        except (KeyError, TypeError, ValueError):
            continue
    return good, len(candidates) - len(good)
