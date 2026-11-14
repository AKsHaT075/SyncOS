"""The `tool_activity` frame: exactly {type, tool}; sent only for a call that passed validation, before its Node callback starts."""
import asyncio
import json

import httpx
import pytest

from app.core import errors as E
from app.orchestration.generate import encode_frame
from app.tools.definitions import DEFINITIONS
from tests.conftest import Upstream
from tests.test_tools_loop import direct, types
from tests.tool_support import BODY, FakeNode, build_app, frames_of, mint, text_chunks, tool_call_chunks

VALID_ARGS = {
    "list_my_tasks": {"limit": 3}, "list_my_schedule": {"range": "today"}, "list_projects": {"limit": 3}, "get_project_overview": {"project": "Apollo"},
    "list_project_members": {"project": "Apollo"}, "list_project_tasks": {"project": "Apollo"}, "get_team": {}, "get_workload_summary": {"scope": "me"},
}


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


def activity(r):
    return [f for f in frames_of(r.text) if f["type"] == "tool_activity"]


@pytest.mark.parametrize("name", sorted(DEFINITIONS))
async def test_every_one_of_the_eight_tools_is_announced_by_name_only(env, name):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("call_9", name, json.dumps(VALID_ARGS[name]))))
    upstream.enqueue(body=text_chunks("ok"))
    r = await ask(env)
    assert activity(r) == [{"type": "tool_activity", "tool": name}]
    assert [b["name"] for b in node.bodies] == [name]
    wire = [b for b in r.text.split("\n\n") if b.startswith("event: tool_activity")][0]
    assert wire == f'event: tool_activity\ndata: {{"type":"tool_activity","tool":"{name}"}}'  # compact, two fields, nothing else
    inner = json.dumps(VALID_ARGS[name])[1:-1]
    assert (not inner or inner not in wire) and "call_9" not in r.text  # no argument text, no call id


async def test_the_event_is_never_sent_for_refused_invalid_or_unknown_calls(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(
        ("a", "delete_everything", "{}"),  # unknown
        ("b", "list_projects", '{"limit": 5,'),  # malformed JSON
        ("c", "list_projects", '{"organization": "x"}'),  # unexpected argument
        ("d", "get_project_overview", "{}"),  # missing required
        ("e", "list_projects", "[1]"),  # not an object
    ))
    upstream.enqueue(body=text_chunks("sorry"))
    r = await ask(env)
    assert activity(r) == [] and node.requests == [] and types(r) == ["usage", "text", "usage", "done"]


async def test_a_repeated_call_is_not_announced_a_second_time(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("c1", "list_projects", '{"limit":2}'), ("c2", "list_projects", '{"limit":2}')))
    upstream.enqueue(body=text_chunks("done"))
    r = await ask(env)
    assert len(activity(r)) == 1 and len(node.requests) == 1


async def test_calls_beyond_the_budget_are_not_announced(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(*[(f"c{i}", "list_projects", json.dumps({"limit": i + 1})) for i in range(7)]))
    upstream.enqueue(body=text_chunks("done"))
    r = await ask(env)
    assert len(activity(r)) == 5 == len(node.requests)  # one per call actually sent; the two refused for budget are silent


async def test_a_protocol_error_before_any_call_announces_nothing(env):
    client, upstream, node, keys = env
    upstream.enqueue(body=tool_call_chunks(("same", "list_projects", "{}"), ("same", "get_team", "{}")))
    r = await ask(env)
    assert activity(r) == [] and frames_of(r.text)[-1]["code"] == E.INVALID_RESPONSE


async def test_activity_is_not_model_output_or_usage(env):
    client, upstream, node, keys = env
    node.responder = lambda b: (500, {"success": False, "code": "AI_TOOL_FAILED"})
    upstream.enqueue(body=tool_call_chunks(("c1", "list_projects", "{}"), usage={"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}))
    upstream.enqueue(status=500, body="{}")
    r = await ask(env)
    frames = frames_of(r.text)
    assert [f["type"] for f in frames] == ["usage", "tool_activity", "error"]  # the snapshot of the finished round comes first; the error frame does not repeat it
    assert frames[0] == {"type": "usage", "inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "estimated": False}  # only what Groq reported
    assert frames[-1]["streamStarted"] is False  # an announcement is not "output started": nothing was retried or charged differently


async def test_the_frame_is_handed_over_BEFORE_the_callback_starts(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=tool_call_chunks(("c1", "list_projects", "{}")))
    upstream.enqueue(body=text_chunks("final"))
    gen = direct(upstream, node, keys)()
    snapshot = json.loads((await gen.__anext__()).decode().split("data: ", 1)[1])
    assert snapshot["type"] == "usage"  # the finished round is reported FIRST
    first = json.loads((await gen.__anext__()).decode().split("data: ", 1)[1])
    assert first == {"type": "tool_activity", "tool": "list_projects"}
    await asyncio.sleep(0.1)
    assert node.requests == []  # the consumer has the frame; the generator is still parked on it, so the callback has NOT begun
    rest = [json.loads(b.decode().split("data: ", 1)[1])["type"] async for b in gen]
    assert len(node.requests) == 1 and rest == ["text", "usage", "done"]


async def test_cancelling_at_the_announcement_means_the_callback_never_happens(keys):
    upstream, node = Upstream(), FakeNode()
    upstream.enqueue(body=tool_call_chunks(("c1", "list_projects", "{}")))
    upstream.enqueue(body=text_chunks("never"))
    gen = direct(upstream, node, keys)()
    await gen.__anext__()  # announced
    await gen.aclose()  # the browser went away before the callback
    await asyncio.sleep(0.1)
    assert node.requests == [] and len(upstream.requests) == 1


async def test_two_concurrent_calls_are_each_announced_before_their_own_callback(keys):
    upstream, node = Upstream(), FakeNode()
    node.delay = 0.05
    upstream.enqueue(body=tool_call_chunks(("a", "list_projects", '{"limit":1}'), ("b", "get_team", "{}")))
    upstream.enqueue(body=text_chunks("done"))
    gen = direct(upstream, node, keys)()
    seen_before = []
    async for raw in gen:
        payload = json.loads(raw.decode().split("data: ", 1)[1])
        if payload["type"] == "tool_activity":
            seen_before.append((payload["tool"], len(node.requests)))
    assert [name for name, _ in seen_before] == ["list_projects", "get_team"]
    assert seen_before[0][1] == 0 and seen_before[1][1] <= 1  # the second is announced before ITS callback (the first may be running)
    assert len(node.requests) == 2


def test_the_wire_encoding_is_the_shared_fixture():
    assert encode_frame({"type": "tool_activity", "tool": "get_team"}) == b'event: tool_activity\ndata: {"type":"tool_activity","tool":"get_team"}\n\n'
