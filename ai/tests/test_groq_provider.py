import asyncio
import json

import httpx
import pytest

from app.core import errors as E
from app.core.errors import ProviderError
from app.providers.groq import GroqProvider
from tests.conftest import Upstream, _no_sleep, delta, make_settings, sse

MODEL = "openai/gpt-oss-120b"
MSGS = [{"role": "user", "content": "PROMPT-SECRET hello"}]
USAGE = {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}


async def run(provider, **kw):
    out = []
    async for e in provider.chat(model=MODEL, messages=MSGS, **kw):
        out.append(e)
    return out


async def fail_of(provider, **kw):
    with pytest.raises(ProviderError) as e:
        await run(provider, **kw)
    return e.value


def mk(public_keys, upstream, **over):
    return GroqProvider(make_settings(public_keys, **over), http=upstream.client(), sleep=_no_sleep)


# ---- happy path and request shape ---------------------------------------------------------

async def test_streams_text_usage_done(provider, upstream):
    events = await run(provider)
    assert [e["type"] for e in events] == ["text", "usage", "done"]
    assert events[0]["text"] == "hi"
    assert events[1] == {"type": "usage", "inputTokens": 5, "outputTokens": 2, "totalTokens": 7, "estimated": False}
    assert events[2]["finishReason"] == "stop" and events[2]["provider"] == "groq" and events[2]["model"] == MODEL


async def test_request_shape_and_credentials(provider, upstream):
    await run(provider, max_output_tokens=100)
    req = upstream.requests[0]
    assert str(req.url) == "https://groq.test/openai/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer gsk_TEST_KEY_NOT_REAL"
    body = upstream.body()
    assert body["stream"] is True and body["model"] == MODEL and body["max_completion_tokens"] == 100
    assert "stream_options" not in body and "tools" not in body and "tool_choice" not in body


async def test_output_cap_can_be_lowered_never_raised(public_keys, upstream):
    p = mk(public_keys, upstream, max_output_tokens=300)
    await run(p, max_output_tokens=10_000)
    assert upstream.body()["max_completion_tokens"] == 300


async def test_tools_are_mapped_and_tool_choice_only_with_tools(provider, upstream):
    tools = [{"name": "list_tasks", "description": "d", "parameters": {"type": "object", "properties": {}}}]
    await run(provider, tools=tools, tool_choice="auto")
    body = upstream.body()
    assert body["tools"] == [{"type": "function", "function": {"name": "list_tasks", "description": "d", "parameters": {"type": "object", "properties": {}}}}]
    assert body["tool_choice"] == "auto"
    await run(provider, tool_choice="auto")
    assert "tool_choice" not in upstream.body()


async def test_canonical_messages_map_to_wire_format(provider, upstream):
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "toolCalls": [{"id": "c1", "name": "t", "arguments": {"a": 1}}]},
        {"role": "tool", "toolCallId": "c1", "name": "t", "content": "result"},
    ]
    async for _ in provider.chat(model=MODEL, messages=msgs):
        pass
    wire = upstream.body()["messages"]
    assert wire[1] == {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "t", "arguments": '{"a": 1}'}}]}
    assert wire[2] == {"role": "tool", "tool_call_id": "c1", "name": "t", "content": "result"}


async def test_reasoning_deltas_are_ignored(provider, upstream):
    upstream.enqueue(200, sse(delta(reasoning="SECRET-THOUGHTS"), delta("answer"), delta(finish="stop")))
    events = await run(provider)
    assert [e["text"] for e in events if e["type"] == "text"] == ["answer"]
    assert "SECRET-THOUGHTS" not in json.dumps(events)


async def test_usage_from_x_groq_is_accepted(provider, upstream):
    last = delta(finish="stop")
    last["x_groq"] = {"usage": USAGE}
    upstream.enqueue(200, sse(delta("a"), last))
    usage = [e for e in await run(provider) if e["type"] == "usage"][0]
    assert usage["totalTokens"] == 7 and usage["estimated"] is False


async def test_missing_usage_is_estimated_and_flagged(provider, upstream):
    upstream.enqueue(200, sse(delta("x" * 40), delta(finish="stop")))
    usage = [e for e in await run(provider) if e["type"] == "usage"][0]
    assert usage["estimated"] is True and usage["outputTokens"] == 10 and usage["inputTokens"] > 0


# ---- tool calls ------------------------------------------------------------------------------

async def test_tool_call_fragments_are_assembled_once(provider, upstream):
    upstream.enqueue(200, sse(
        delta(tool_calls=[{"index": 0, "id": "call_a", "function": {"name": "list_", "arguments": ""}}]),
        delta(tool_calls=[{"index": 0, "function": {"name": "tasks", "arguments": '{"lim'}}]),
        delta(tool_calls=[{"index": 0, "function": {"arguments": 'it":5}'}}, {"index": 1, "id": "call_b", "function": {"name": "other", "arguments": "{}"}}]),
        delta(finish="tool_calls", usage=USAGE)))
    events = await run(provider, tools=[{"name": "list_tasks"}, {"name": "other"}])
    calls = [e for e in events if e["type"] == "tool_calls"]
    assert len(calls) == 1
    first, second = calls[0]["calls"]
    assert (first["id"], first["name"], first["input"], first["inputError"]) == ("call_a", "list_tasks", {"limit": 5}, False)
    assert second["name"] == "other" and second["input"] == {}
    assert events[-1]["finishReason"] == "tool_calls"


async def test_malformed_tool_arguments_are_flagged_not_dropped(provider, upstream):
    upstream.enqueue(200, sse(delta(tool_calls=[{"index": 0, "id": "c", "function": {"name": "t", "arguments": "{oops"}}]), delta(finish="tool_calls")))
    call = [e for e in await run(provider, tools=[{"name": "t"}]) if e["type"] == "tool_calls"][0]["calls"][0]
    assert call["inputError"] is True and call["input"] is None and call["arguments"] == "{oops"


# ---- error mapping (shared fixture with the Node suite) -----------------------------------------

def _cases():
    from tests.conftest import load_contract

    return load_contract("error_mapping.json")["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: f"{c['status']}-{c['code']}")
def test_http_failure_mapping_matches_the_shared_fixture(case):
    from app.providers.errors import from_http_response

    error = from_http_response(case["status"], case["body"], case["headers"])
    assert (error.code, error.retryable) == (case["code"], case["retryable"])
    assert error.retry_after_ms == case["retryAfterMs"]
    assert error.upstream_status == case["status"]


async def test_error_carries_no_upstream_text_prompt_or_key(provider, upstream):
    upstream.enqueue(400, {"error": {"message": "echo PROMPT-SECRET gsk_TEST_KEY_NOT_REAL", "code": "weird"}})
    error = await fail_of(provider)
    blob = repr(error) + str(error) + json.dumps(error.frame())
    assert "PROMPT-SECRET" not in blob and "gsk_TEST" not in blob
    assert error.code == E.BAD_REQUEST


async def test_not_configured_makes_no_request(public_keys, upstream):
    p = mk(public_keys, upstream, groq_api_key="")
    assert (await fail_of(p)).code == E.NOT_CONFIGURED
    assert upstream.requests == []


async def test_invalid_params_make_no_request(provider, upstream):
    with pytest.raises(ProviderError):
        async for _ in provider.chat(model=MODEL, messages=[]):
            pass
    with pytest.raises(ProviderError):
        async for _ in provider.chat(model=MODEL, messages=MSGS, tools=[{"name": "bad name!"}]):
            pass
    assert upstream.requests == []


async def test_error_event_inside_the_stream_is_normalized(provider, upstream):
    upstream.enqueue(200, sse({"error": {"message": "x", "status_code": 429}}))
    assert (await fail_of(provider, max_retries=0)).code == E.RATE_LIMITED


# ---- retries ---------------------------------------------------------------------------------

async def test_retries_before_output_then_succeeds(provider, upstream):
    upstream.enqueue(503, {"error": {}}).enqueue(429, {"error": {}})
    events = await run(provider)
    assert events[-1]["type"] == "done"
    assert len(upstream.requests) == 3


async def test_retry_is_not_visible_to_the_caller_as_extra_events(provider, upstream):
    upstream.enqueue(500, {})
    events = await run(provider)
    assert [e["type"] for e in events] == ["text", "usage", "done"]  # exactly one usage: nothing to double charge


async def test_gives_up_after_max_retries(provider, upstream):
    for _ in range(5):
        upstream.enqueue(503, {})
    error = await fail_of(provider)
    assert error.code == E.UNAVAILABLE and error.stream_started is False
    assert len(upstream.requests) == 3  # 1 + 2 retries


async def test_does_not_retry_non_retryable(provider, upstream):
    upstream.enqueue(401, {})
    assert (await fail_of(provider)).code == E.AUTH
    assert len(upstream.requests) == 1


async def test_retry_after_header_is_honoured_and_capped(public_keys, upstream):
    waits = []

    async def spy(seconds):
        waits.append(seconds)

    p = GroqProvider(make_settings(public_keys), http=upstream.client(), sleep=spy)
    upstream.enqueue(429, {}, {"retry-after": "3"}).enqueue(429, {}, {"retry-after": "9999"})
    await run(p)
    assert waits == [3.0, 10.0]


async def test_never_retries_after_output_has_started(provider, upstream):
    async def broken():
        yield f"data: {json.dumps(delta('partial'))}\n\n".encode()
        raise httpx.ReadError("reset")

    upstream.enqueue(200, stream=broken)
    out = []
    with pytest.raises(ProviderError) as e:
        async for ev in provider.chat(model=MODEL, messages=MSGS):
            out.append(ev)
    assert out == [{"type": "text", "text": "partial"}]
    assert e.value.stream_started is True and e.value.code == E.UNAVAILABLE
    assert len(upstream.requests) == 1  # a half-written answer is never replayed


async def test_truncated_stream_after_output_is_an_error(provider, upstream):
    upstream.enqueue(200, sse(delta("half"), done=False))
    out = []
    with pytest.raises(ProviderError) as e:
        async for ev in provider.chat(model=MODEL, messages=MSGS):
            out.append(ev)
    assert e.value.code == E.UNAVAILABLE and e.value.stream_started is True
    assert [x["type"] for x in out] == ["text"]
    assert len(upstream.requests) == 1


async def test_empty_stream_before_output_is_retried(provider, upstream):
    upstream.enqueue(200, "")
    events = await run(provider)
    assert events[-1]["type"] == "done" and len(upstream.requests) == 2


async def test_network_failure_is_retryable_unavailable(public_keys):
    calls = []

    def handler(request):
        calls.append(1)
        raise httpx.ConnectError("dns")

    p = GroqProvider(make_settings(public_keys), http=httpx.AsyncClient(transport=httpx.MockTransport(handler)), sleep=_no_sleep)
    error = await fail_of(p)
    assert error.code == E.UNAVAILABLE and len(calls) == 3


# ---- timeouts and cancellation ------------------------------------------------------------------

async def test_first_event_timeout_is_retryable(public_keys, upstream):
    async def silent():
        await asyncio.sleep(5)
        yield b""

    p = mk(public_keys, upstream, first_byte_timeout_ms=40)
    upstream.enqueue(200, stream=silent)
    events = await run(p)  # second attempt uses the default plan and succeeds
    assert events[-1]["type"] == "done" and len(upstream.requests) == 2
    assert upstream.closed >= 2  # the stalled response was closed


async def test_idle_timeout_after_output_is_not_retried(public_keys, upstream):
    async def stalls():
        yield f"data: {json.dumps(delta('one'))}\n\n".encode()
        await asyncio.sleep(5)

    p = mk(public_keys, upstream, stream_idle_timeout_ms=40, first_byte_timeout_ms=1000)
    upstream.enqueue(200, stream=stalls)
    out = []
    with pytest.raises(ProviderError) as e:
        async for ev in p.chat(model=MODEL, messages=MSGS):
            out.append(ev)
    assert e.value.code == E.TIMEOUT and e.value.stream_started is True and e.value.retryable is False
    assert len(upstream.requests) == 1


async def test_total_timeout(public_keys, upstream):
    async def drip():
        while True:
            yield f"data: {json.dumps(delta('.'))}\n\n".encode()
            await asyncio.sleep(0.02)

    p = mk(public_keys, upstream, request_timeout_ms=150, stream_idle_timeout_ms=1000)
    upstream.enqueue(200, stream=drip)
    with pytest.raises(ProviderError) as e:
        await run(p)
    assert e.value.code == E.TIMEOUT


async def test_cancelling_the_consumer_closes_the_upstream_response(provider, upstream):
    async def endless():
        yield f"data: {json.dumps(delta('x'))}\n\n".encode()
        await asyncio.sleep(30)

    upstream.enqueue(200, stream=endless)
    got = asyncio.Event()

    async def consume():
        async for _ in provider.chat(model=MODEL, messages=MSGS):
            got.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(got.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert upstream.closed == 1
    assert len(upstream.requests) == 1  # and no retry was attempted after the cancel


async def test_closing_the_generator_early_closes_the_upstream_response(provider, upstream):
    gen = provider.chat(model=MODEL, messages=MSGS)
    await gen.__anext__()
    await gen.aclose()
    assert upstream.closed == 1


async def test_cancel_during_retry_backoff_makes_no_further_request(public_keys, upstream):
    gate = asyncio.Event()

    async def slow_sleep(_):
        await gate.wait()

    p = GroqProvider(make_settings(public_keys), http=upstream.client(), sleep=slow_sleep)
    upstream.enqueue(503, {})
    task = asyncio.create_task(run(p))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(upstream.requests) == 1
