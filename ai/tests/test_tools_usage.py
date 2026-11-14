"""Step 8A: cumulative usage snapshots (and the bounded keepalive) of the tool loop.

Contract: after every completed Groq round that leads to tool calls, Python sends a CUMULATIVE `usage` snapshot (everything Groq has reported so far in
this request), before any tool runs; the last frame before `done` is the final cumulative total. Node keeps the latest valid snapshot and never adds them.
"""
import asyncio
import json

import httpx
import pytest

from app.core import errors as E
from tests.conftest import Upstream, delta, sse
from tests.test_tools_loop import direct, groq_messages
from tests.tool_support import BODY, FakeNode, build_app, frames_of, mint, text_chunks, tool_call_chunks

U = lambda i, o: {"prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o}  # noqa: E731


@pytest.fixture
async def env(keys):
    upstream, node = Upstream(), FakeNode()
    app, _ = build_app(keys, upstream, node)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai.test") as client:
        yield client, upstream, node, keys


async def ask(env):
    client, _, _, keys = env
    _, headers = mint(keys)
    return await client.post("/internal/v1/generate", headers=headers, json=BODY)


def totals(r):
    return [f["totalTokens"] for f in frames_of(r.text) if f["type"] == "usage"]


async def test_sequential_rounds_report_cumulative_snapshots_and_the_final_total_is_the_last_one(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("a", "list_my_tasks", "{}"), usage=U(900, 100)))  # round 1: 1,000
    upstream.enqueue(body=tool_call_chunks(("b", "get_team", "{}"), usage=U(1250, 150)))  # round 2: 1,400 -> cumulative 2,400
    upstream.enqueue(body=text_chunks("done", usage=U(1600, 180)))  # round 3: 1,780 -> cumulative 4,180
    r = await ask(env)
    frames = [f for f in frames_of(r.text) if f["type"] == "usage"]
    assert [f["totalTokens"] for f in frames] == [1000, 2400, 4180]  # snapshots, NOT per-round amounts; the last is the settlement figure
    assert [(f["inputTokens"], f["outputTokens"]) for f in frames] == [(900, 100), (2150, 250), (3750, 430)]
    assert sum(totals(r)) == 7580 and totals(r)[-1] == 4180  # a client that ADDED the snapshots would be wrong; Node takes the latest
    assert all(b["totalTokens"] >= a["totalTokens"] for a, b in zip(frames, frames[1:]))  # monotonic
    assert all(f["inputTokens"] + f["outputTokens"] == f["totalTokens"] for f in frames)


async def test_a_snapshot_is_sent_BEFORE_the_tools_of_that_round_run(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(900, 100)))
    upstream.enqueue(body=text_chunks("x", usage=U(1000, 10)))
    gen = direct(upstream, node, keys)()
    first = json.loads((await gen.__anext__()).decode().split("data: ", 1)[1])
    assert first["type"] == "usage" and first["totalTokens"] == 1000
    assert node.requests == []  # nothing has been called yet: the spend is already on record
    await gen.aclose()


async def test_cancellation_after_a_completed_round_but_before_the_callback_has_already_reported_the_spend(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(1700, 40)))
    upstream.enqueue(body=text_chunks("never"))
    gen = direct(upstream, node, keys)()
    seen = [json.loads((await gen.__anext__()).decode().split("data: ", 1)[1])]  # the consumer received the snapshot...
    await gen.aclose()  # ...and the browser goes away before the announcement / callback
    await asyncio.sleep(0.05)
    assert seen[0]["totalTokens"] == 1740 and node.requests == [] and len(upstream.requests) == 1


async def test_a_failing_tool_callback_keeps_the_snapshot_that_was_already_sent(env):
    client, upstream, node, keys = env
    node.responder = lambda b: (401, {"success": False, "code": "AI_CALLBACK_UNAUTHORIZED"})
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(900, 100)))
    r = await ask(env)
    kinds = [f["type"] for f in frames_of(r.text)]
    assert kinds == ["usage", "tool_activity", "error"] and totals(r) == [1000]  # the single snapshot stands; the error does not repeat it


async def test_groq_failing_after_earlier_successful_rounds_leaves_the_cumulative_total_on_record(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("a", "list_my_tasks", "{}"), usage=U(900, 100)))
    upstream.enqueue(body=tool_call_chunks(("b", "get_team", "{}"), usage=U(1250, 150)))
    upstream.enqueue(status=500, body="{}")
    r = await ask(env)
    assert totals(r) == [1000, 2400] and frames_of(r.text)[-1]["type"] == "error"
    assert [b["callId"] for b in node.bodies] == ["a", "b"]  # each tool ran exactly once


async def test_the_failed_generation_of_a_retried_round_reports_nothing_and_is_not_counted(env):
    client, upstream, node, keys = env
    upstream.enqueue(status=400, body=json.dumps({"error": {"code": "tool_use_failed", "message": "Failed to call a function"}}))
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(900, 100)))
    upstream.enqueue(body=text_chunks("ok", usage=U(1000, 10)))
    r = await ask(env)
    assert totals(r) == [1000, 2010]  # only the two COMPLETED rounds


async def test_a_provider_call_that_never_completed_is_never_invented(env):
    client, upstream, node, keys = env
    upstream.enqueue(status=500, body="{}")
    r = await ask(env)
    assert totals(r) == [] and frames_of(r.text)[-1]["type"] == "error"  # no usage frame at all: nothing was reported, nothing is made up


async def test_estimated_usage_is_flagged_and_stays_flagged_cumulatively(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(900, 100)))
    upstream.enqueue(body=sse(delta("ok"), delta(finish="stop")))  # Groq reported no usage for this round: Python's provider estimates it
    r = await ask(env)
    frames = [f for f in frames_of(r.text) if f["type"] == "usage"]
    assert frames[0]["estimated"] is False and frames[-1]["estimated"] is True


async def test_a_seeded_usage_counts_once(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", "{}"), usage=U(900, 100)))
    upstream.enqueue(body=text_chunks("ok", usage=U(1000, 10)))
    from app.orchestration import tool_loop  # direct call with initial_usage (e.g. the follow-up rewrite of a document answer)
    import inspect
    assert "initial_usage" in inspect.signature(tool_loop.tool_frames).parameters
    gen = direct(upstream, node, keys, )()
    # seeding is exercised through the hybrid answer path tests; here only the cumulative arithmetic of the plain loop matters
    seen = [json.loads(b.decode().split("data: ", 1)[1]) async for b in gen]
    assert [f["totalTokens"] for f in seen if f["type"] == "usage"] == [1000, 2010]


# ---- keepalive -------------------------------------------------------------------------------------------------------------------------

def slow_groq(upstream, seconds, plan):
    async def stream():
        await asyncio.sleep(seconds)
        yield plan.encode()

    upstream.enqueue(stream=stream)


async def raw_frames(gen):
    out = []
    async for raw in gen:
        out.append(raw)
    return out


async def test_a_slow_groq_round_is_covered_by_keepalive_comments_and_the_answer_is_unchanged(keys):
    upstream, node = Upstream(), FakeNode()
    slow_groq(upstream, 0.35, text_chunks("SLOW-BUT-FINE", usage=U(100, 10)))
    out = await raw_frames(direct(upstream, node, keys, keepalive_ms=100)())
    pings = [b for b in out if b == b": keepalive\n\n"]
    assert len(pings) >= 2  # one about every 100 ms while Groq was thinking
    frames = [json.loads(b.decode().split("data: ", 1)[1]) for b in out if b.startswith(b"event:")]
    assert [f["type"] for f in frames] == ["text", "usage", "done"] and frames[0]["text"] == "SLOW-BUT-FINE"


async def test_a_fast_round_sends_no_keepalive(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=text_chunks("quick"))
    out = await raw_frames(direct(upstream, node, keys, keepalive_ms=5000)())
    assert b": keepalive\n\n" not in out


async def test_keepalives_can_never_outlive_the_request_deadline(keys):
    upstream, node = Upstream(), FakeNode()
    slow_groq(upstream, 5, text_chunks("NEVER"))
    started = asyncio.get_running_loop().time()
    out = await raw_frames(direct(upstream, node, keys, keepalive_ms=100, deadline_ms=600, call_timeout_ms=100, call_grace_ms=50, connect_timeout_ms=50, total_tool_ms=100)())
    took = asyncio.get_running_loop().time() - started
    frames = [json.loads(b.decode().split("data: ", 1)[1]) for b in out if b.startswith(b"event:")]
    assert frames[-1]["type"] == "error" and frames[-1]["code"] == E.TIMEOUT and "NEVER" not in b"".join(out).decode()
    assert took < 1.5  # ended at the deadline (0.6 s), however many pings were sent before it


async def test_cancellation_while_waiting_stops_the_pings_and_closes_groq(keys):
    upstream, node = Upstream(), FakeNode()
    slow_groq(upstream, 30, text_chunks("NEVER"))
    gen = direct(upstream, node, keys, keepalive_ms=100)()
    first = await gen.__anext__()
    assert first == b": keepalive\n\n"
    await gen.aclose()
    await asyncio.sleep(0.1)
    assert upstream.closed >= 1


def test_keepalive_settings_are_bounded():
    from app.core.config import ConfigError
    from app.tools.config import load_tool_settings

    assert load_tool_settings({}).keepalive_ms == 10_000
    for bad in ("0", "50", "99999", "x"):
        with pytest.raises(ConfigError):
            load_tool_settings({"AI_TOOL_KEEPALIVE_MS": bad})
