from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from ..core import security
from ..core.config import VERSION
from ..core.replay import ReplayStoreUnavailable
from ..orchestration.generate import generate_frames
from ..orchestration.tool_loop import tool_frames
from ..rag.answer import answer_frames
from ..schemas.answer import AnswerRequest
from ..schemas.generate import GenerateRequest
from ..tools.context import ToolContext

log = logging.getLogger("ai.api")
router = APIRouter()


def fail(status: int, code: str) -> JSONResponse:
    # Static, content-free body: nothing from the request is ever echoed back.
    return JSONResponse({"error": {"code": code}}, status_code=status)


def bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/internal/v1/status")
async def status(request: Request):
    state = request.app.state
    try:
        security.verify(bearer(request), audience=security.AUD_STATUS, keys=state.settings.jwt_public_keys)
    except security.TokenError as error:
        log.info("status rejected reason=%s", error.reason)
        return fail(401, "TOKEN_INVALID")
    replay_ok = await state.replay.ping()
    return {
        "configured": state.settings.configured,
        "provider": "groq",
        "models": state.settings.models(),
        "version": VERSION,
        "replayStore": state.replay.name,
        "replayStoreHealthy": replay_ok,
        "retrieval": {"enabled": state.rag is not None},
    }


@router.post("/internal/v1/generate")
async def generate(request: Request):
    state = request.app.state
    settings = state.settings

    try:
        claims = security.verify(bearer(request), audience=security.AUD_GENERATE, keys=settings.jwt_public_keys)
    except security.TokenError as error:
        log.info("generate rejected reason=%s", error.reason)
        return fail(401, "TOKEN_INVALID")

    if not settings.configured:
        return fail(503, "NOT_CONFIGURED")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
        return fail(413, "BODY_TOO_LARGE")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > settings.max_body_bytes:
            return fail(413, "BODY_TOO_LARGE")
    try:
        body = GenerateRequest.model_validate_json(bytes(raw))
    except ValidationError:
        return fail(422, "BAD_REQUEST")  # never echo pydantic's detail: it includes the offending input

    # Live tools need BOTH halves of Node's authorization: the signed `lt` claim AND a tool token minted for this very request.
    # Either alone (or a token for another purpose/request/user) is refused outright: no tools, and no plain answer either.
    tool_token = None
    if claims.live_tools:
        try:
            tool_token = security.verify_tool_token(request.headers.get("x-syncos-tool-token", "").strip(), claims=claims, keys=settings.jwt_public_keys)
        except security.TokenError as error:
            log.info("generate tool authorization rejected reason=%s", error.reason)
            return fail(401, "TOKEN_INVALID")

    # Last gate before any work: prove this token has not been used. Fail closed if we cannot prove it.
    ttl = max(1, claims.exp - int(time.time())) + security.LEEWAY_SECONDS + 1
    try:
        first_use = await state.replay.consume(claims.jti, ttl)
    except ReplayStoreUnavailable:
        log.error("replay store unavailable")
        return fail(503, "REPLAY_STORE_UNAVAILABLE")
    if not first_use:
        log.warning("generate replay rejected request=%s", claims.jti)
        return fail(409, "REPLAYED")

    if tool_token is not None:
        try:
            limits = settings.tools.bounded_by(claims.tool_limits)  # Node's limits are the ceiling; ours may only be stricter
        except ValueError:
            log.error("generate refused: tool limits incompatible request=%s", claims.jti)
            return fail(503, "TOOLS_MISCONFIGURED")
        frames = tool_frames(
            provider=state.provider, http=state.tool_http, body=body, tool_token=tool_token, settings=settings, request_id=claims.jti,
            max_output_tokens=min(claims.max_output_tokens or settings.max_output_tokens, settings.max_output_tokens),
            model=settings.model_for(body.purpose), limits=limits,
        )
        return StreamingResponse(frames, media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    frames = generate_frames(
        state.provider,
        body,
        request_id=claims.jti,
        max_output_tokens=min(claims.max_output_tokens or settings.max_output_tokens, settings.max_output_tokens),
        model=settings.model_for(body.purpose),
    )
    return StreamingResponse(frames, media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})



@router.post("/internal/v1/answer")
async def answer(request: Request):
    """Permission-aware RAG. Identity, organization and the ACTIVE embedding space come from the signed token; the body is
    only the question; the callback token (also minted by Node, for this request only) is what lets us ask Node which
    retrieved chunks the user may use."""
    state = request.app.state
    settings = state.settings

    try:
        claims = security.verify(bearer(request), audience=security.AUD_GENERATE, keys=settings.jwt_public_keys)
    except security.TokenError as error:
        log.info("answer rejected reason=%s", error.reason)
        return fail(401, "TOKEN_INVALID")
    if claims.space is None:
        return fail(401, "TOKEN_INVALID")  # a token minted for plain generation cannot start retrieval
    callback_token = request.headers.get("x-syncos-callback-token", "").strip()
    if not callback_token or len(callback_token) > 4096:
        return fail(400, "CALLBACK_REQUIRED")
    if state.rag is None:
        return fail(503, "RETRIEVAL_DISABLED")
    if not settings.configured:
        return fail(503, "NOT_CONFIGURED")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
        return fail(413, "BODY_TOO_LARGE")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > settings.max_body_bytes:
            return fail(413, "BODY_TOO_LARGE")
    try:
        body = AnswerRequest.model_validate_json(bytes(raw))
    except ValidationError:
        return fail(422, "BAD_REQUEST")
    if len(body.question) > settings.rag.max_question_chars:
        return fail(422, "BAD_REQUEST")

    # A document answer MAY also use live tools: only with BOTH signals (the signed `lt` claim and a tool token minted for this request), exactly as on
    # /generate. The knowledge token above and the tool token are different tokens with different scopes; either alone never enables the other.
    tool_context = None
    if claims.live_tools:
        try:
            tool_token = security.verify_tool_token(request.headers.get("x-syncos-tool-token", "").strip(), claims=claims, keys=settings.jwt_public_keys)
        except security.TokenError as error:
            log.info("answer tool authorization rejected reason=%s", error.reason)
            return fail(401, "TOKEN_INVALID")
        try:
            tool_context = ToolContext(http=state.tool_http, token=tool_token, settings=settings, limits=settings.tools.bounded_by(claims.tool_limits))
        except ValueError:
            log.error("answer refused: tool limits incompatible request=%s", claims.jti)
            return fail(503, "TOOLS_MISCONFIGURED")

    ttl = max(1, claims.exp - int(time.time())) + security.LEEWAY_SECONDS + 1
    try:
        first_use = await state.replay.consume(claims.jti, ttl)
    except ReplayStoreUnavailable:
        log.error("replay store unavailable")
        return fail(503, "REPLAY_STORE_UNAVAILABLE")
    if not first_use:
        log.warning("answer replay rejected request=%s", claims.jti)
        return fail(409, "REPLAYED")

    frames = answer_frames(
        question=body.question,
        history=[t.model_dump() for t in body.history],
        claims=claims,
        rag=state.rag,
        groq=state.provider,
        model=settings.model_for("chat"),
        max_output_tokens=min(claims.max_output_tokens or settings.max_output_tokens, settings.max_output_tokens),
        callback_token=callback_token,
        request_id=claims.jti,
        tools=tool_context,
    )
    return StreamingResponse(frames, media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
