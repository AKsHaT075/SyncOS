"""Live tools need BOTH the signed `lt` claim and a tool token minted for this request. Anything else: no tools (and no answer)."""
import httpx
import jwt
import pytest

from tests.conftest import Upstream
from tests.test_api import post
from tests.tool_support import BODY, FakeNode, build_app, frames_of, mint, text_chunks, tool_call_chunks


@pytest.fixture
async def env(keys):
    upstream, node = Upstream(), FakeNode()
    app, settings = build_app(keys, upstream, node)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai.test") as client:
        yield client, upstream, node


async def go(client, headers, body=BODY):
    return await client.post("/internal/v1/generate", headers=headers, json=body)


async def test_valid_pair_runs_the_tool_loop(env, keys):
    client, upstream, node = env
    upstream.enqueue(body=tool_call_chunks(("call_1", "list_projects", "{}"))).enqueue(body=text_chunks("You have none."))
    _, headers = mint(keys)
    r = await go(client, headers)
    assert r.status_code == 200 and [f["type"] for f in frames_of(r.text)] == ["usage", "tool_activity", "text", "usage", "done"]
    assert len(node.requests) == 1


BAD = {
    "lt claim without a tool token": dict(tool=False),
    "lt: false (Node only ever sends true, or omits it)": dict(lt=False),
    "lt: 'true' (a string)": dict(lt="true"),
    "lt: 1": dict(lt=1),
    "tool token for knowledge:authorize": dict(scp=("knowledge:authorize",)),
    "tool token with an extra purpose": dict(scp=("tool:execute", "knowledge:authorize")),
    "tool token with no purpose": dict(scp=()),
    "tool token minted for another request": dict(rid="another-request-id-0001"),
    "tool token for another user": dict(tool_extra={"sub": "x" * 24}),
    "tool token for another organization": dict(tool_extra={"org": "x" * 24}),
    "a GENERATE-audience token used as the tool token": dict(tool_aud="syncos-ai:generate"),
    "tool token signed by a different key": dict(tool_key="other"),
    "tool token with an unknown key id": dict(tool_kid="nope"),
    "tool token with an absurd lifetime": dict(tool_lifetime=5000),
    "expired tool token": dict(tool_lifetime=-60),
}


@pytest.mark.parametrize("label", list(BAD))
async def test_missing_or_mismatched_authorization_runs_nothing(env, keys, label):
    client, upstream, node = env
    kwargs = dict(BAD[label])
    _, headers = mint(keys, **kwargs)
    r = await go(client, headers)
    assert r.status_code == 401 and r.json() == {"error": {"code": "TOKEN_INVALID"}}
    assert upstream.requests == [] and node.requests == []  # no Groq call, no callback, nothing


async def test_tool_token_without_lt_never_enables_tools(env, keys):
    client, upstream, node = env
    upstream.enqueue(body=tool_call_chunks(("call_1", "list_projects", "{}")))
    _, headers = mint(keys, lt=None)  # a tool header, but the signed token does not say live tools
    r = await go(client, headers)
    assert r.status_code == 200 and node.requests == []  # plain path: whatever the model says, Python runs nothing
    assert "tools" not in upstream.body()
    assert [f["type"] for f in frames_of(r.text)][:1] == ["tool_calls"]  # unchanged pre-Step-6 behaviour of the plain path (Node ignores it)


async def test_request_body_cannot_switch_tools_on(env, keys):
    client, upstream, node = env
    _, headers = mint(keys, lt=None, tool=False)
    for extra in ({"liveTools": True}, {"lt": True}, {"callbackToken": "x"}, {"toolToken": "x"}):
        r = await go(client, headers, {**BODY, **extra})
        assert r.status_code == 422  # strict body: unknown fields are refused
    assert node.requests == [] and upstream.requests == []


async def test_in_tool_mode_the_body_cannot_choose_or_extend_the_tools(env, keys):
    client, upstream, node = env
    upstream.enqueue(body=text_chunks("ok"))
    _, headers = mint(keys)
    body = {**BODY, "tools": [{"name": "delete_everything", "description": "x", "parameters": {"type": "object", "properties": {}}}], "toolChoice": "required"}
    r = await go(client, headers, body)
    assert r.status_code == 200
    names = [t["function"]["name"] for t in upstream.body()["tools"]]
    assert names == sorted(names) and len(names) == 8 and "delete_everything" not in names
    assert upstream.body()["tool_choice"] == "auto"


async def test_alg_none_and_garbage_tool_tokens_are_refused(env, keys):
    client, upstream, node = env
    _, headers = mint(keys, tool=False)
    for bad in ("", "x", "a.b.c", jwt.encode({"scp": ["tool:execute"]}, key="", algorithm="none"), "A" * 5000):
        r = await go(client, {**headers, "X-Syncos-Tool-Token": bad})
        assert r.status_code == 401
    assert upstream.requests == [] and node.requests == []


async def test_a_replayed_generate_token_still_cannot_run_tools_twice(env, keys):
    client, upstream, node = env
    upstream.enqueue(body=text_chunks("one"))
    _, headers = mint(keys)
    assert (await go(client, headers)).status_code == 200
    assert (await go(client, headers)).status_code == 409
    assert node.requests == [] and len(upstream.requests) == 1


# ---- Node's limits travel inside the signed token and Python can only tighten them -------------------------------------------------

from app.core import security  # noqa: E402
from app.core.config import ConfigError  # noqa: E402
from app.tools.config import ToolSettings, load_tool_settings  # noqa: E402
from tests.tool_support import NODE_LIMITS  # noqa: E402

BAD_TL = {
    "missing while lt is true": None,
    "an extra key": {**NODE_LIMITS, "x": 1},
    "a missing key": {k: v for k, v in NODE_LIMITS.items() if k != "c"},
    "a string value": {**NODE_LIMITS, "c": "5"},
    "a boolean": {**NODE_LIMITS, "c": True},
    "zero calls": {**NODE_LIMITS, "c": 0},
    "absurd calls": {**NODE_LIMITS, "c": 5000},
    "per-call longer than the total": {**NODE_LIMITS, "t": 30000, "m": 20000},
    "more concurrent than calls": {**NODE_LIMITS, "k": 6, "c": 5},
    "tool time that does not fit the ceiling": {**NODE_LIMITS, "m": 115000, "d": 120000},
}


@pytest.mark.parametrize("label", list(BAD_TL))
async def test_a_missing_or_incoherent_limits_claim_refuses_the_request(env, keys, label):
    client, upstream, node = env
    _, headers = mint(keys, tl=BAD_TL[label])
    r = await go(client, headers)
    assert r.status_code == 401 and upstream.requests == [] and node.requests == []


async def test_limits_without_live_tools_are_refused(env, keys):
    client, upstream, node = env
    _, headers = mint(keys, lt=None, tool=False, tl=dict(NODE_LIMITS))
    assert (await go(client, headers)).status_code == 401


async def test_node_limits_tighten_python_defaults_per_request(env, keys):
    client, upstream, node = env
    upstream.enqueue(body=tool_call_chunks(*[(f"c{i}", "list_projects", f'{{"limit":{i + 1}}}') for i in range(5)]))
    upstream.enqueue(body=text_chunks("done"))
    _, headers = mint(keys, tl={**NODE_LIMITS, "c": 2, "k": 1})  # Node says: 2 calls, one at a time
    await go(client, headers)
    assert len(node.requests) == 2 and node.max_active == 1


async def test_node_limits_cannot_be_loosened_by_python_configuration(keys):
    # even if this process were configured with MORE than Node allows, Node's number wins
    s = ToolSettings(max_calls=20, max_rounds=6, max_concurrent=4, call_timeout_ms=30000, total_tool_ms=60000, max_result_bytes=65536, deadline_ms=500000)
    node = security.NodeToolLimits(rounds=3, calls=5, concurrent=2, call_ms=8000, total_ms=20000, result_bytes=6144, ceiling_ms=120000)
    got = s.bounded_by(node)
    assert (got.max_rounds, got.max_calls, got.max_concurrent, got.call_timeout_ms, got.total_tool_ms, got.max_result_bytes, got.deadline_ms) == (3, 5, 2, 8000, 20000, 6144, 110000)


async def test_python_may_be_stricter_than_node(keys):
    s = ToolSettings(max_calls=2, max_rounds=1, max_concurrent=1, call_timeout_ms=3000, total_tool_ms=6000, deadline_ms=60000)
    node = security.NodeToolLimits(rounds=3, calls=5, concurrent=2, call_ms=8000, total_ms=20000, result_bytes=6144, ceiling_ms=120000)
    got = s.bounded_by(node)
    assert (got.max_rounds, got.max_calls, got.max_concurrent, got.call_timeout_ms, got.total_tool_ms, got.deadline_ms) == (1, 2, 1, 3000, 6000, 60000)


async def test_node_limits_that_leave_no_room_fail_closed(env, keys):
    client, upstream, node = env
    # a 15 s ceiling leaves 5 s for the whole request: less than one call needs (8 s + grace). Refuse; do not run with less safety.
    _, headers = mint(keys, tl={**NODE_LIMITS, "d": 15000, "m": 5000, "t": 5000})
    r = await go(client, headers)
    assert r.status_code == 503 and r.json() == {"error": {"code": "TOOLS_MISCONFIGURED"}}
    assert upstream.requests == [] and node.requests == []


@pytest.mark.parametrize("name,value", [
    ("AI_TOOL_MAX_CALLS", "0"), ("AI_TOOL_MAX_CALLS", "-1"), ("AI_TOOL_MAX_CALLS", "many"), ("AI_TOOL_MAX_CALLS", "999"),
    ("AI_TOOL_MAX_CONCURRENT", "9"), ("AI_TOOL_TIMEOUT_MS", "999999"), ("AI_TOOL_TOTAL_MS", "0"), ("AI_TOOL_MAX_ROUNDS", "99"),
    ("AI_NODE_INTERNAL_URL", "ftp://x"), ("AI_NODE_INTERNAL_URL", "http://user:pw@127.0.0.1:5002"), ("AI_NODE_INTERNAL_URL", "http://127.0.0.1:5002/evil"),
    ("AI_NODE_INTERNAL_URL", "http://127.0.0.1:5002?x=1"),
])
def test_invalid_python_tool_settings_refuse_to_start(name, value):
    with pytest.raises(ConfigError):
        load_tool_settings({name: value})


@pytest.mark.parametrize("env_", [
    {"AI_TOOL_MAX_CONCURRENT": "4", "AI_TOOL_MAX_CALLS": "2"},  # more in flight than calls allowed
    {"AI_TOOL_TIMEOUT_MS": "30000", "AI_TOOL_TOTAL_MS": "10000"},  # one call longer than all calls together
])
def test_inconsistent_python_tool_settings_refuse_to_start(env_):
    with pytest.raises(ConfigError):
        load_tool_settings(env_)


def test_defaults_are_consistent_and_equal_nodes_defaults():
    d = load_tool_settings({})
    assert (d.max_rounds, d.max_calls, d.max_concurrent, d.call_timeout_ms, d.total_tool_ms) == (3, 5, 2, 8000, 20000)
