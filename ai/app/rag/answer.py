"""One RAG request, as wire frames.

    retrieval  {counts only}                      what retrieval did (never text, never ids)
    text ...   usage   citations   done           the answer, then ONLY the sources it actually cited
    error      {code, ...}                        terminal failure

When nothing relevant AND authorized exists the answer is a fixed "not found" message and Groq is not called at all:
no cost, and nothing to invent. Otherwise Groq gets a hardened prompt (rag/prompt.py) and NO tools.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncIterator

from ..core import errors as E
from ..core.errors import ProviderError
from ..embeddings.provider import EmbeddingError
from ..orchestration.generate import encode_frame
from ..vectorstore.base import VectorStoreError
from .authorizer import AuthorizerError
from .citations import markers_in
from .condense import condense
from .language import no_answer_message
from .prompt import build_hybrid_messages, build_messages
from .retrieval import Retrieval, retrieve
from .runtime import RagRuntime

log = logging.getLogger("ai.rag")


def _add_usage(frame: dict, extra: dict | None) -> dict:
    if not extra:
        return frame
    return {**frame, **{k: frame.get(k, 0) + extra.get(k, 0) for k in ("inputTokens", "outputTokens", "totalTokens")}, "estimated": bool(frame.get("estimated") or extra.get("estimated"))}


def citations_frame(text: str, retrieval: Retrieval) -> dict:
    by_n = {s.n: s for s in retrieval.sources}
    cited = [n for n in markers_in(text) if n in by_n]
    unverified = [n for n in markers_in(text) if n not in by_n]
    return {
        "type": "citations",
        "citations": [by_n[n].public() for n in cited],  # only sources that were retrieved, authorized AND cited
        "unverifiedMarkers": unverified,  # numbers the model wrote that match no source we gave it
        "consideredSources": len(retrieval.sources),
        "uncited": len(cited) == 0,
    }


async def answer_frames(*, question: str, claims, rag: RagRuntime, groq, model: str, max_output_tokens: int, callback_token: str, request_id: str, history=(), tools=None) -> AsyncIterator[bytes]:
    started = time.monotonic()
    outcome, code, produced = "error", None, False
    retrieval = Retrieval()
    events = None
    prior = None  # usage of the follow-up rewrite call, if one was made: it is real Groq usage and is charged
    standalone = question
    try:
        try:
            embedder, store = await rag.ready()
            if claims.space != embedder.space_id:
                # Node says which embedding space is ACTIVE. If this process embeds into another one, comparing the two would
                # silently return nonsense. Refuse instead.
                raise EmbeddingError("EMBEDDING_SPACE_MISMATCH")
            standalone, prior = await condense(groq, model, question, history)  # no history: returns the question itself, no call
            if tools is not None and prior:
                # live-tools request: Node keeps the LATEST cumulative snapshot, so the rewrite call's real spend is on record before retrieval starts
                yield encode_frame({"type": "usage", **{k: prior[k] for k in ("inputTokens", "outputTokens", "totalTokens", "estimated")}})
            vector = await asyncio.to_thread(embedder.embed_query, standalone)
            retrieval = await retrieve(vector=vector, store=store, authorizer=rag.authorizer(callback_token), organization=claims.org, space_id=embedder.space_id, cfg=rag.settings)
        except asyncio.CancelledError:
            raise
        except (EmbeddingError, VectorStoreError, AuthorizerError) as error:
            code = error.code
            raise ProviderError(E.RETRIEVAL_UNAVAILABLE) from None
        yield encode_frame({"type": "retrieval", **retrieval.stats()})

        if tools is not None:
            # HYBRID: documents AND live tools. The sources Node authorized go into a delimited block of the user message; tool results come back as TOOL
            # messages. The two channels never mix, each is authorized by Node on its own token, and with NO matching documents the tools still run.
            from ..orchestration.tool_loop import tool_frames  # local import: the tool loop is only needed here

            outcome = "hybrid"
            messages = build_hybrid_messages(standalone, [{"n": s.n, "text": s.text} for s in retrieval.sources])
            async for raw in tool_frames(
                provider=groq, http=tools.http, messages=messages, tool_token=tools.token, settings=tools.settings, request_id=request_id,
                max_output_tokens=max_output_tokens, model=model, limits=tools.limits, initial_usage=prior,
                before_done=lambda text: [citations_frame(text, retrieval)],
            ):
                yield raw
            return

        if not retrieval.sources:
            outcome = "no_context"
            yield encode_frame({"type": "text", "text": no_answer_message(question)})
            yield encode_frame(_add_usage({"type": "usage", "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "estimated": False}, prior))
            yield encode_frame(citations_frame("", retrieval))
            yield encode_frame({"type": "done", "finishReason": "no_context", "model": None, "provider": "groq", "requestId": None, "firstEventMs": 0})
            return

        messages = build_messages(standalone, [{"n": s.n, "text": s.text} for s in retrieval.sources])
        events = groq.chat(model=model, messages=messages, tools=None, tool_choice=None, temperature=0.1, max_output_tokens=max_output_tokens)
        answer = []
        async for event in events:
            if event["type"] == "text":
                produced = True
                answer.append(event["text"])
            if event["type"] == "done":
                yield encode_frame(citations_frame("".join(answer), retrieval))
                yield encode_frame(event)
                outcome = "done"
                return
            if event["type"] == "tool_calls":
                continue  # no tools were offered; a tool call here is a model/provider anomaly and is never forwarded
            yield encode_frame(_add_usage(event, prior) if event["type"] == "usage" else event)
        code = E.INVALID_RESPONSE
        yield encode_frame(ProviderError(code, stream_started=produced).frame())
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except ProviderError as error:
        code = code or error.code
        error.stream_started = error.stream_started or produced
        yield encode_frame(error.frame())
    except Exception as error:  # a bug on our side; the class name is the only thing safe to log
        code = type(error).__name__
        log.error("answer unexpected failure type=%s", code)
        yield encode_frame(ProviderError(E.UNAVAILABLE, stream_started=produced).frame())
    finally:
        if events is not None:
            await events.aclose()
        log.info("answer request=%s outcome=%s code=%s ms=%d %s", request_id, outcome, code, (time.monotonic() - started) * 1000, retrieval.stats())
