"""The RAG answer stream and the /internal/v1/answer route."""
import asyncio
import dataclasses
import hashlib
import json
import logging

import httpx
import numpy as np
import pytest

from app.core import errors as E
from app.embeddings.fake_provider import FakeProvider
from app.embeddings.provider import ModelUnavailable
from app.main import create_app
from app.core.replay import MemoryReplayGuard
from app.providers.groq import GroqProvider
from app.rag.answer import answer_frames
from app.rag.authorizer import AuthorizerError, key_of, validate_items
from app.rag.config import RagSettings
from app.rag.language import NO_ANSWER
from app.rag.runtime import RagRuntime
from app.vectorstore.base import StoreUnavailable, VectorItem
from app.vectorstore.memory_store import MemoryStore
from tests.conftest import _no_sleep, make_settings

ORG = "a" * 24
SECRET = "BOARD-CONFIDENTIAL layoffs are planned"
LEAVE = "All employees receive twenty four days of paid leave every year and may carry five days over"
EXPENSES = "Expense claims must be submitted with receipts within thirty days to be reimbursed"
PRIVATE = f"{SECRET} salary bands paid leave every year"  # shares words with the leave question on purpose


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()


def did(i):
    return f"{i:024d}"


CFG = RagSettings(enabled=True, min_score=0.2, score_window=0.5, top_k=4)


class StubAuthorizer:
    def __init__(self, texts, allowed=None, fail=None):
        self.texts, self.allowed, self.fail, self.asked = texts, allowed, fail, []

    async def authorize(self, candidates):
        self.asked.append([c.document for c in candidates])
        if self.fail:
            raise self.fail
        items = [{"documentId": c.document, "version": c.version, "chunkIndex": c.chunk_index, "chunkId": f"chunk-{int(c.document)}", "textHash": c.text_hash, "text": self.texts[int(c.document)], "tokens": 20, "documentName": f"doc-{int(c.document)}.txt", "location": {"pageStart": 1, "pageEnd": 1}} for c in candidates if self.allowed is None or int(c.document) in self.allowed]
        return validate_items(candidates, items)


class Runtime(RagRuntime):
    def __init__(self, settings, embedder, store, authorizer):
        super().__init__(settings, embedder=embedder, store=store, http=httpx.AsyncClient())
        self._auth = authorizer

    def authorizer(self, callback_token):
        self.token_seen = callback_token
        return self._auth


class StubGroq:
    def __init__(self, texts=("Leave is 24 days [1].",), fail_after_text=False, tool_call=False):
        self.texts, self.fail_after_text, self.tool_call, self.calls, self.closed = texts, fail_after_text, tool_call, [], False

    def chat(self, **kw):
        self.calls.append(kw)
        return self._gen()

    async def _gen(self):
        try:
            if self.tool_call:
                yield {"type": "tool_calls", "calls": [{"id": "c", "name": "delete_everything", "arguments": "{}", "input": {}, "inputError": False}]}
            for t in self.texts:
                yield {"type": "text", "text": t}
            if self.fail_after_text:
                from app.core.errors import ProviderError

                raise ProviderError(E.UNAVAILABLE, stream_started=True)
            yield {"type": "usage", "inputTokens": 300, "outputTokens": 20, "totalTokens": 320, "estimated": False}
            yield {"type": "done", "finishReason": "stop", "model": "openai/gpt-oss-120b", "provider": "groq", "requestId": "r1", "firstEventMs": 5}
        finally:
            self.closed = True


@dataclasses.dataclass
class Claims:
    org: str = ORG
    space: str | None = None
    sub: str = "u" * 24


def build(docs, *, allowed=None, fail=None, provider=None, store=None, cfg=CFG):
    provider = provider or FakeProvider()
    store = store or MemoryStore()
    store.ensure_collection(provider.space_id, provider.dimensions)
    for i, text in docs.items():
        store.upsert(organization=ORG, document=did(i), version=1, ingestion_pipeline="p2", space_id=provider.space_id, items=[VectorItem(0, sha(text), provider.embed_passages([text])[0])])
    auth = StubAuthorizer(docs, allowed, fail)
    return Runtime(cfg, provider, store, auth), provider, auth


async def collect(rag, provider, groq, question="How many days of paid leave do I get every year?", claims=None):
    claims = claims or Claims(space=provider.space_id)
    out = []
    async for raw in answer_frames(question=question, claims=claims, rag=rag, groq=groq, model="m", max_output_tokens=200, callback_token="CB-TOKEN", request_id="req1"):
        for block in raw.decode().strip().split("\n\n"):
            out.append(json.loads(block.split("data: ", 1)[1]))
    return out


# ---- the happy path ---------------------------------------------------------------------------------------------------------------------

async def test_stream_shape_and_citations_only_for_authorized_cited_sources():
    rag, p, auth = build({1: LEAVE, 2: EXPENSES, 3: PRIVATE}, allowed={1, 2})
    groq = StubGroq(texts=("Twenty four days ", "[1] and nonsense [9]."))
    frames = await collect(rag, p, groq)
    assert [f["type"] for f in frames] == ["retrieval", "text", "text", "usage", "citations", "done"]
    assert frames[0]["used"] >= 1 and set(frames[0]) == {"type", "candidates", "authorized", "rejected", "belowThreshold", "duplicates", "used", "rounds", "topScore"}
    cit = frames[4]
    assert [c["documentId"] for c in cit["citations"]] == [did(1)] and cit["unverifiedMarkers"] == [9]
    assert cit["citations"][0]["documentName"] == "doc-1.txt" and cit["citations"][0]["chunkId"] == "chunk-1"
    assert frames[-1]["type"] == "done" and frames[-1]["model"] == "openai/gpt-oss-120b"
    assert rag.token_seen == "CB-TOKEN"  # the per-request callback token is what reaches the authorizer


async def test_groq_receives_only_authorized_text_in_a_hardened_prompt_and_no_tools():
    rag, p, auth = build({1: LEAVE, 2: EXPENSES, 3: PRIVATE}, allowed={1, 2})
    groq = StubGroq()
    await collect(rag, p, groq)
    (call,) = groq.calls
    prompt = json.dumps(call["messages"])
    assert SECRET not in prompt and "salary bands" not in prompt  # the unauthorized document's text never reached the model
    assert call["tools"] is None and call["tool_choice"] is None
    assert [m["role"] for m in call["messages"]] == ["system", "user"]
    assert "doc-1.txt" not in prompt and did(1) not in prompt  # no names or ids in the prompt
    assert "<source id=\"1\">" in call["messages"][1]["content"]


async def test_a_tool_call_from_the_model_is_never_forwarded():
    rag, p, _ = build({1: LEAVE})
    frames = await collect(rag, p, StubGroq(tool_call=True))
    assert "tool_calls" not in [f["type"] for f in frames]


# ---- nothing relevant and authorized => a fixed answer, no model call -----------------------------------------------------------------------

@pytest.mark.parametrize(
    "question,expected",
    [("Where is the quarterly rocket fuel budget?", "en"), ("रॉकेट ईंधन का बजट कहाँ है?", "hi"), ("ਰਾਕੇਟ ਬਾਲਣ ਦਾ ਬਜਟ ਕਿੱਥੇ ਹੈ?", "pa")],
)
async def test_no_relevant_context_means_a_fixed_localized_message_and_no_groq_call(question, expected):
    rag, p, _ = build({1: LEAVE}, cfg=dataclasses.replace(CFG, min_score=0.99))
    groq = StubGroq()
    frames = await collect(rag, p, groq, question=question)
    assert groq.calls == []  # no tokens spent, nothing that could be invented
    assert [f["type"] for f in frames] == ["retrieval", "text", "usage", "citations", "done"]
    assert frames[1]["text"] == NO_ANSWER[expected] and frames[2]["totalTokens"] == 0
    assert frames[3]["citations"] == [] and frames[-1]["finishReason"] == "no_context"


async def test_when_the_only_matching_documents_are_unauthorized_the_answer_is_not_found_and_their_text_is_never_requested_twice():
    rag, p, auth = build({3: PRIVATE}, allowed=set())
    groq = StubGroq()
    frames = await collect(rag, p, groq)
    assert groq.calls == [] and frames[-1]["finishReason"] == "no_context"
    assert frames[0]["authorized"] == 0 and frames[0]["rejected"] >= 1


# ---- failures ------------------------------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("which", ["authorizer", "store", "embedder", "space"])
async def test_retrieval_failures_end_in_one_content_free_error_frame_and_never_call_groq(which, caplog):
    caplog.set_level(logging.DEBUG)
    rag, p, auth = build({1: LEAVE}, fail=AuthorizerError("AUTHORIZER_REFUSED") if which == "authorizer" else None)
    claims = Claims(space=p.space_id)
    if which == "store":
        rag._store.down = True
    elif which == "embedder":
        p.fail_next = ModelUnavailable()
    elif which == "space":
        claims = Claims(space="ffffffffffff")  # Node says another space is active than the one this process embeds into
    groq = StubGroq()
    frames = await collect(rag, p, groq, question="SECRET-QUESTION paid leave days?", claims=claims)
    assert frames == [{"type": "error", "code": E.RETRIEVAL_UNAVAILABLE, "retryable": False, "streamStarted": False, "upstreamStatus": None}]
    assert groq.calls == []
    assert "SECRET-QUESTION" not in caplog.text


async def test_a_groq_failure_after_output_reports_stream_started_and_no_citations():
    rag, p, _ = build({1: LEAVE})
    frames = await collect(rag, p, StubGroq(fail_after_text=True))
    assert frames[-1]["type"] == "error" and frames[-1]["streamStarted"] is True and "citations" not in [f["type"] for f in frames]


async def test_cancelling_the_consumer_closes_the_model_stream():
    rag, p, _ = build({1: LEAVE})
    groq = StubGroq(texts=("one", "two", "three"))
    gen = answer_frames(question="paid leave every year days", claims=Claims(space=p.space_id), rag=rag, groq=groq, model="m", max_output_tokens=10, callback_token="t", request_id="r")
    await gen.__anext__()  # retrieval
    await gen.__anext__()  # first text
    await gen.aclose()
    assert groq.closed is True


async def test_logs_carry_counts_but_never_the_question_or_document_text(caplog):
    caplog.set_level(logging.DEBUG)
    rag, p, _ = build({1: LEAVE})
    await collect(rag, p, StubGroq(), question="Where is SECRET-QUESTION-MARKER mentioned in paid leave every year?")
    assert "SECRET-QUESTION-MARKER" not in caplog.text and "paid leave" not in caplog.text and "twenty four" not in caplog.text.lower()
    assert "outcome=done" in caplog.text


# ---- the route ----------------------------------------------------------------------------------------------------------------------------------------

def authorize_handler(docs, allowed=None):
    def handler(request: httpx.Request):
        assert request.headers["authorization"] == "Bearer CALLBACK-JWT"
        body = json.loads(request.content)
        items = []
        for c in body["candidates"]:
            i = int(c["documentId"])
            if (allowed is None or i in allowed) and i in docs and sha(docs[i]) == c["textHash"]:
                items.append({"documentId": c["documentId"], "version": c["version"], "chunkIndex": c["chunkIndex"], "chunkId": f"chunk-{i}", "textHash": c["textHash"], "text": docs[i], "tokens": 20, "documentName": f"doc-{i}.txt", "location": {}})
        return httpx.Response(200, json={"items": items})

    return handler


def make_app(public_keys, upstream, *, rag_on=True, docs=None, allowed=None, groq_configured=True):
    settings = make_settings(public_keys, groq_api_key="gsk_TEST_KEY_NOT_REAL" if groq_configured else "")
    p = FakeProvider()
    store = MemoryStore()
    store.ensure_collection(p.space_id, p.dimensions)
    docs = docs or {1: LEAVE, 2: EXPENSES}
    for i, t in docs.items():
        store.upsert(organization=ORG, document=did(i), version=1, ingestion_pipeline="p2", space_id=p.space_id, items=[VectorItem(0, sha(t), p.embed_passages([t])[0])])
    cfg = dataclasses.replace(CFG, node_url="http://node.test")
    rag = RagRuntime(cfg, embedder=p, store=store, http=httpx.AsyncClient(transport=httpx.MockTransport(authorize_handler(docs, allowed)))) if rag_on else None
    app = create_app(settings, provider=GroqProvider(settings, http=upstream.client(), sleep=_no_sleep), replay=MemoryReplayGuard(), rag=rag)
    return app, p


def auth(tok):
    return {"Authorization": f"Bearer {tok}", "X-Syncos-Callback-Token": "CALLBACK-JWT"}


async def ask(app, token, body=None, headers=None):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        return await c.post("/internal/v1/answer", headers=headers or auth(token), json=body or {"question": "How many days of paid leave every year?"})


def parse(text):
    return [json.loads(b.split("data: ", 1)[1]) for b in text.strip().split("\n\n") if b and not b.startswith(":")]


async def test_route_streams_an_answer_end_to_end(public_keys, upstream, token):
    from tests.conftest import delta, sse

    upstream.enqueue(200, sse(delta("Twenty four days [1]."), delta(finish="stop", usage={"prompt_tokens": 200, "completion_tokens": 8, "total_tokens": 208})))
    app, p = make_app(public_keys, upstream)
    r = await ask(app, token(spc=p.space_id, org=ORG))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    frames = parse(r.text)
    assert [f["type"] for f in frames] == ["retrieval", "text", "usage", "citations", "done"]
    assert frames[3]["citations"][0]["documentName"] == "doc-1.txt"
    sent = upstream.body()
    assert sent["model"] == "openai/gpt-oss-120b" and "tools" not in sent and [m["role"] for m in sent["messages"]] == ["system", "user"]
    assert "twenty four days" in sent["messages"][1]["content"].lower()


async def test_route_security_gates(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream)
    space = p.space_id
    assert (await ask(app, token(), headers=auth(token()))).status_code == 401  # a plain generate token (no embedding space) cannot start retrieval
    assert (await ask(app, "garbage")).status_code == 401
    assert (await ask(app, token(spc=space), headers={"Authorization": f"Bearer {token(spc=space)}"})).status_code == 400  # callback token is mandatory
    assert (await ask(app, token(spc="NOT-A-SPACE"))).status_code == 401
    assert (await ask(app, token(aud="syncos-ai:status", spc=space))).status_code == 401
    assert upstream.requests == []


@pytest.mark.parametrize("extra", [{"organization": "x" * 24}, {"user": "u"}, {"documentIds": ["a"]}, {"spaceId": "abcdef123456"}, {"topK": 99}, {"messages": []}])
async def test_route_body_is_only_the_question(public_keys, upstream, token, extra):
    app, p = make_app(public_keys, upstream)
    r = await ask(app, token(spc=p.space_id), body={"question": "q?", **extra})
    assert r.status_code == 422 and r.json() == {"error": {"code": "BAD_REQUEST"}}


async def test_route_rejects_empty_and_oversized_questions_and_replays(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream)
    t = token(spc=p.space_id)
    assert (await ask(app, token(spc=p.space_id), body={"question": "   "})).status_code == 422
    assert (await ask(app, token(spc=p.space_id), body={"question": "x" * 2001})).status_code == 422
    assert (await ask(app, t)).status_code == 200
    again = await ask(app, t)
    assert again.status_code == 409 and again.json() == {"error": {"code": "REPLAYED"}}


async def test_route_when_retrieval_is_disabled_or_groq_is_unconfigured(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream, rag_on=False)
    assert (await ask(app, token(spc=FakeProvider().space_id))).status_code == 503
    app2, p2 = make_app(public_keys, upstream, groq_configured=False)
    assert (await ask(app2, token(spc=p2.space_id))).status_code == 503
    assert upstream.requests == []


async def test_route_with_the_wrong_embedding_space_fails_closed(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream)
    r = await ask(app, token(spc="abcdef123456"))
    assert parse(r.text) == [{"type": "error", "code": E.RETRIEVAL_UNAVAILABLE, "retryable": False, "streamStarted": False, "upstreamStatus": None}]
    assert upstream.requests == []


async def test_route_status_reports_whether_retrieval_is_enabled(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/internal/v1/status", headers={"Authorization": f"Bearer {token(aud='syncos-ai:status')}"})
    assert r.json()["retrieval"] == {"enabled": True}


async def test_the_organization_comes_from_the_signed_token_so_another_tenants_token_finds_nothing(public_keys, upstream, token):
    app, p = make_app(public_keys, upstream)
    r = await ask(app, token(spc=p.space_id, org="b" * 24))  # a valid token, but for a different organization than the indexed documents
    frames = parse(r.text)
    assert frames[0]["candidates"] == 0 and frames[-1]["finishReason"] == "no_context"
    assert upstream.requests == []  # and the model was never called
