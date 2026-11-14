import asyncio
import json
import logging

import httpx
import pytest

from app.core.replay import ReplayGuard, ReplayStoreUnavailable
from app.main import create_app
from app.providers.groq import GroqProvider
from tests.conftest import _no_sleep, delta, make_settings, sse

BODY = {"purpose": "chat", "messages": [{"role": "user", "content": "PROMPT-SECRET hi"}]}


def auth(tok):
    return {"Authorization": f"Bearer {tok}"}


def frames(text):
    out = []
    for block in text.strip().split("\n\n"):
        if block.startswith(":") or not block:
            continue
        out.append(json.loads(block.split("data: ", 1)[1]))
    return out


async def post(client, token, body=BODY, **kw):
    return await client.post("/internal/v1/generate", headers=auth(token), json=body, **kw)


async def test_health_is_public_and_minimal(client):
    r = await client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
async def test_no_self_describing_endpoints(client, path):
    assert (await client.get(path)).status_code == 404


async def test_status_requires_a_status_token_and_leaks_no_secret(client, token, settings):
    assert (await client.get("/internal/v1/status")).status_code == 401
    assert (await client.get("/internal/v1/status", headers=auth(token()))).status_code == 401  # generate token is the wrong audience
    r = await client.get("/internal/v1/status", headers=auth(token(aud="syncos-ai:status")))
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True and body["replayStore"] == "memory" and body["models"]["chat"]
    assert settings.groq_api_key not in r.text


async def test_generate_streams_contract_frames(client, token, upstream):
    r = await post(client, token())
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = frames(r.text)
    assert [e["type"] for e in events] == ["text", "usage", "done"]
    assert events[-1]["provider"] == "groq"
    assert r.headers["cache-control"] == "no-store"


async def test_unauthenticated_and_bad_tokens_never_reach_groq(client, token, upstream):
    assert (await client.post("/internal/v1/generate", json=BODY)).status_code == 401
    assert (await post(client, "garbage")).status_code == 401
    assert (await post(client, token(aud="syncos-ai:status"))).status_code == 401
    assert (await post(client, token(kid="nope"))).status_code == 401
    assert upstream.requests == []


async def test_a_token_cannot_be_replayed(client, token, upstream):
    t = token(jti="req-0000-aaaa")
    assert (await post(client, t)).status_code == 200
    again = await post(client, t)
    assert again.status_code == 409 and again.json() == {"error": {"code": "REPLAYED"}}
    assert len(upstream.requests) == 1


async def test_concurrent_replays_run_the_request_exactly_once(client, token, upstream):
    t = token(jti="req-0000-race")
    results = await asyncio.gather(*[post(client, t) for _ in range(20)])
    assert sorted(r.status_code for r in results).count(200) == 1
    assert len(upstream.requests) == 1


async def test_replay_store_down_fails_closed(settings, upstream, token):
    class Down:
        name = "redis"

        async def consume(self, *a):
            raise ReplayStoreUnavailable()

        async def ping(self):
            return False

        async def close(self):
            pass

    app = create_app(settings, provider=GroqProvider(settings, http=upstream.client(), sleep=_no_sleep), replay=Down())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await post(c, token())
    assert r.status_code == 503 and r.json()["error"]["code"] == "REPLAY_STORE_UNAVAILABLE"
    assert upstream.requests == []


async def test_not_configured_is_503_and_makes_no_request(public_keys, upstream, token):
    s = make_settings(public_keys, groq_api_key="")
    app = create_app(s, provider=GroqProvider(s, http=upstream.client()))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await post(c, token())
    assert r.status_code == 503 and r.json()["error"]["code"] == "NOT_CONFIGURED"
    assert upstream.requests == []


@pytest.mark.parametrize("extra", [{"user": "u1"}, {"organization": "o1"}, {"role": "org-admin"}, {"permissions": ["*"]}, {"maxOutputTokens": 99999}, {"model": "x"}])
async def test_identity_and_unknown_fields_in_the_body_are_rejected(client, token, upstream, extra):
    r = await post(client, token(), {**BODY, **extra})
    assert r.status_code == 422 and r.json() == {"error": {"code": "BAD_REQUEST"}}
    assert upstream.requests == []


async def test_validation_errors_do_not_echo_the_request(client, token):
    r = await post(client, token(), {"messages": [{"role": "user", "content": "PROMPT-SECRET", "bogus": 1}]})
    assert r.status_code == 422 and "PROMPT-SECRET" not in r.text


async def test_malformed_and_oversized_bodies(client, token, public_keys, upstream):
    r = await client.post("/internal/v1/generate", headers={**auth(token()), "content-type": "application/json"}, content=b"{not json")
    assert r.status_code == 422
    s = make_settings(public_keys, max_body_bytes=200)
    app = create_app(s, provider=GroqProvider(s, http=upstream.client()), replay=None or __import__("app.core.replay", fromlist=["x"]).MemoryReplayGuard())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        big = await post(c, token(), {"messages": [{"role": "user", "content": "x" * 1000}]})
    assert big.status_code == 413 and upstream.requests == []


async def test_budget_comes_from_the_signed_token(client, token, upstream):
    await post(client, token(mo=77))
    assert upstream.body()["max_completion_tokens"] == 77


async def test_purpose_selects_the_model(client, token, upstream, public_keys):
    await post(client, token(), {**BODY, "purpose": "summarize"})
    assert upstream.body()["model"] == "openai/gpt-oss-120b"


async def test_provider_failure_before_output_is_an_error_frame(client, token, upstream):
    for _ in range(5):
        upstream.enqueue(429, {"error": {"message": "PROMPT-SECRET echoed"}})
    r = await post(client, token())
    assert r.status_code == 200
    (frame,) = frames(r.text)
    assert frame == {"type": "error", "code": "AI_PROVIDER_RATE_LIMITED", "retryable": True, "streamStarted": False, "upstreamStatus": 429}
    assert "PROMPT-SECRET" not in r.text


async def test_failure_after_output_reports_stream_started(client, token, upstream):
    async def broken():
        yield f"data: {json.dumps(delta('partial'))}\n\n".encode()
        raise httpx.ReadError("reset")

    upstream.enqueue(200, stream=broken)
    events = frames((await post(client, token())).text)
    assert [e["type"] for e in events] == ["text", "error"]
    assert events[-1]["streamStarted"] is True and events[-1]["code"] == "AI_PROVIDER_UNAVAILABLE"
    assert len(upstream.requests) == 1


async def test_every_completed_stream_ends_with_exactly_one_terminal_frame(client, token, upstream):
    for plan in [(200, None), (500, {}), (200, sse(delta("x"), done=False))]:
        upstream.plans.clear()
        for _ in range(4):
            upstream.enqueue(plan[0], plan[1] if plan[1] is not None else sse(delta("ok"), delta(finish="stop")))
        events = frames((await post(client, token())).text)
        terminals = [e for e in events if e["type"] in {"done", "error"}]
        assert len(terminals) == 1 and events[-1] is terminals[0]


async def test_logs_never_contain_prompts_keys_or_tokens(client, token, upstream, caplog, settings):
    caplog.set_level(logging.DEBUG)
    tok = token()
    upstream.enqueue(500, {"error": {"message": "PROMPT-SECRET"}})
    await post(client, tok)
    await post(client, tok)  # replay
    await post(client, "bad.token.value")
    text = caplog.text
    for secret in ("PROMPT-SECRET", settings.groq_api_key, tok):
        assert secret not in text


async def test_unhandled_errors_do_not_leak(settings, upstream, token):
    class Boom:
        name = "boom"

        async def consume(self, *a):
            raise RuntimeError("PROMPT-SECRET internals")

        async def ping(self):
            return True

        async def close(self):
            pass

    app = create_app(settings, provider=GroqProvider(settings, http=upstream.client()), replay=Boom())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        r = await post(c, token())
    assert r.status_code == 500 and "PROMPT-SECRET" not in r.text and r.json() == {"error": {"code": "INTERNAL"}}
