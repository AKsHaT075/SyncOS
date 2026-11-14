"""Scaffolding for the live-tool tests: a scripted Groq, a scripted Node, and helpers to mint BOTH tokens for one request.

No real Groq key and no real Node are ever used. Every network call goes through httpx.MockTransport."""
from __future__ import annotations

import asyncio
import json
import uuid

import httpx

from app.core.replay import MemoryReplayGuard
from app.main import create_app
from app.providers.groq import GroqProvider
from tests.conftest import Upstream, _no_sleep, delta, make_settings, sign, sse

SUB, ORG = "u" * 24, "o" * 24
TOOL_TOKEN_MARK = "TOOLTOKEN"


def tool_call_chunks(*calls, usage=None):
    """Groq stream that ends with these tool calls: calls are (id, name, arguments-string)."""
    tcs = [{"index": i, "id": cid, "type": "function", "function": {"name": name, "arguments": args}} for i, (cid, name, args) in enumerate(calls)]
    return sse(delta(tool_calls=tcs), delta(finish="tool_calls", usage=usage or {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}))


def text_chunks(*texts, usage=None):
    chunks = [delta(t) for t in texts]
    chunks.append(delta(finish="stop", usage=usage or {"prompt_tokens": 200, "completion_tokens": 20, "total_tokens": 220}))
    return sse(*chunks)


NODE_LIMITS = {"r": 3, "c": 5, "k": 2, "t": 8000, "m": 20000, "b": 6144, "d": 120000}  # Node's defaults, as it signs them (claim `tl`)


def mint(keys, *, lt=True, tl="node-defaults", tool=True, rid=None, sub=SUB, org=ORG, scp=("tool:execute",), tool_aud="syncos-node:callback", tool_kid="v1", tool_key="v1", tool_lifetime=150, generate_extra=None, tool_extra=None):
    """(generate token, headers for /generate). By default a perfectly valid live-tools pair for ONE request."""
    jti = uuid.uuid4().hex
    gen_claims = {"jti": jti, "sub": sub, "org": org}
    if lt is not None:
        gen_claims["lt"] = lt
    if tl == "node-defaults":
        tl = dict(NODE_LIMITS) if lt is True else None
    if tl is not None:
        gen_claims["tl"] = tl
    gen_claims.update(generate_extra or {})
    gen = sign(keys["v1"][0], **gen_claims)
    headers = {"Authorization": f"Bearer {gen}"}
    if tool:
        claims = {"aud": tool_aud, "jti": uuid.uuid4().hex, "rid": rid or jti, "sub": sub, "org": org, "scp": list(scp), "lifetime": tool_lifetime}
        claims.update(tool_extra or {})
        headers["X-Syncos-Tool-Token"] = sign(keys[tool_key][0], kid=tool_kid, **claims)
    return jti, headers


class FakeNode:
    """Scripted Node tool listener. `respond(body)` -> (status, json|bytes); tracks concurrency and cancellations."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict] = []
        self.responder = self._default
        self.active = 0
        self.max_active = 0
        self.cancelled = 0
        self.delay = 0.0
        self.raise_exc: Exception | None = None

    @staticmethod
    def _default(body):
        return 200, {"success": True, "callId": body["callId"], "result": {"outcome": "ok", "tool": body["name"], "data": [], "summary": {"count": 0, "total": 0, "truncated": False, "complete": True}}}

    async def handler(self, request: httpx.Request):
        self.requests.append(request)
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.raise_exc:
            raise self.raise_exc
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            delay = self.delay(body) if callable(self.delay) else self.delay
            if delay:
                await asyncio.sleep(delay)
            status, payload = self.responder(body)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        finally:
            self.active -= 1
        if isinstance(payload, (bytes, str)):
            return httpx.Response(status, content=payload if isinstance(payload, bytes) else payload.encode(), headers={"content-type": "application/json"} if status != 302 else {"location": "http://evil.test/x"})
        return httpx.Response(status, json=payload)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), follow_redirects=False)


def build_app(keys, upstream: Upstream, node: FakeNode, **settings_over):
    settings = make_settings({"v1": keys["v1"][1]}, max_retries=0, **settings_over)
    return create_app(settings, provider=GroqProvider(settings, http=upstream.client(), sleep=_no_sleep), replay=MemoryReplayGuard(), tool_http=node.client()), settings


def frames_of(text: str) -> list[dict]:
    out = []
    for block in text.strip().split("\n\n"):
        if block and not block.startswith(":"):
            out.append(json.loads(block.split("data: ", 1)[1]))
    return out


BODY = {"purpose": "chat", "messages": [{"role": "system", "content": "NODE-SYSTEM"}, {"role": "user", "content": "QUESTION-SECRET how many projects do I have?"}]}
