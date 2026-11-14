"""Strict ES256 verification of the short-lived tokens Node issues.

Python holds only public keys: it can verify user context but never mint it.
Every failure collapses to TokenError('TOKEN_INVALID'); the specific reason is for
logs/tests only and is never sent to the caller.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping

import jwt

ISSUER = "syncos-node"
AUD_GENERATE = "syncos-ai:generate"
AUD_STATUS = "syncos-ai:status"
AUD_CALLBACK = "syncos-node:callback"  # what Node minted for Python to present BACK to Node (tool execution)
SCOPE_TOOL_EXECUTE = "tool:execute"
MAX_CALLBACK_LIFETIME_SECONDS = 600
MAX_LIFETIME_SECONDS = {AUD_GENERATE: 60, AUD_STATUS: 60}
LEEWAY_SECONDS = 5
_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_REQUIRED = ["exp", "iat", "nbf", "iss", "aud", "jti"]


class TokenError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__("TOKEN_INVALID")
        self.reason = reason  # internal diagnostics only


@dataclass(frozen=True)
class NodeToolLimits:
    """Node's authoritative tool limits for ONE request, from the signed token (claim `tl`). Python may only tighten them."""
    rounds: int
    calls: int
    concurrent: int
    call_ms: int
    total_ms: int
    result_bytes: int
    ceiling_ms: int


# claim key -> (attribute, minimum, maximum): sane bounds, so a bogus or absurd claim is refused rather than trusted
_TL_BOUNDS = {"r": ("rounds", 1, 10), "c": ("calls", 1, 50), "k": ("concurrent", 1, 10), "t": ("call_ms", 100, 60_000), "m": ("total_ms", 100, 300_000), "b": ("result_bytes", 256, 1_048_576), "d": ("ceiling_ms", 10_000, 600_000)}


def _parse_tl(raw) -> NodeToolLimits:
    if not isinstance(raw, dict) or set(raw) != set(_TL_BOUNDS):
        raise TokenError("tl")
    values = {}
    for key, (attr, low, high) in _TL_BOUNDS.items():
        v = raw[key]
        if isinstance(v, bool) or not isinstance(v, int) or not low <= v <= high:
            raise TokenError("tl")
        values[attr] = v
    limits = NodeToolLimits(**values)
    if limits.concurrent > limits.calls or limits.call_ms > limits.total_ms or limits.total_ms + 10_000 > limits.ceiling_ms:
        raise TokenError("tl")  # Node would never send an inconsistent set
    return limits


@dataclass(frozen=True)
class Claims:
    jti: str
    exp: int
    sub: str | None = None
    org: str | None = None
    max_output_tokens: int | None = None
    space: str | None = None  # the embedding space Node says is ACTIVE (RAG only)
    live_tools: bool = False  # `lt`: Node opened a tool budget for this request. ONLY ever read from the signed token.
    tool_limits: NodeToolLimits | None = None  # `tl`: Node's limits for it (always present when live_tools)


def verify(token: str, *, audience: str, keys: Mapping[str, str]) -> Claims:
    if not token or len(token) > 4096:
        raise TokenError("malformed")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise TokenError("malformed") from None
    if header.get("alg") != "ES256":  # also rejects 'none' and any HMAC/RSA confusion
        raise TokenError("alg")
    key = keys.get(header.get("kid") or "")
    if key is None:
        raise TokenError("kid")
    try:
        payload = jwt.decode(
            token,
            key,
            algorithms=["ES256"],
            audience=audience,
            issuer=ISSUER,
            leeway=LEEWAY_SECONDS,
            options={"require": _REQUIRED},
        )
    except jwt.PyJWTError as error:
        raise TokenError(type(error).__name__) from None

    lifetime = payload["exp"] - payload["iat"]
    if lifetime <= 0 or lifetime > MAX_LIFETIME_SECONDS[audience]:
        raise TokenError("lifetime")
    jti = payload["jti"]
    if not isinstance(jti, str) or not _ID.match(jti):
        raise TokenError("jti")

    if audience == AUD_STATUS:
        return Claims(jti=jti, exp=payload["exp"])

    sub, org, mo = payload.get("sub"), payload.get("org"), payload.get("mo")
    if not (isinstance(sub, str) and _ID.match(sub) and isinstance(org, str) and _ID.match(org)):
        raise TokenError("identity")
    if isinstance(mo, bool) or not isinstance(mo, int) or not 1 <= mo <= 100_000:
        raise TokenError("mo")
    spc = payload.get("spc")
    if spc is not None and not (isinstance(spc, str) and re.match(r"^[a-f0-9]{12}$", spc)):
        raise TokenError("spc")
    lt = payload.get("lt")
    if lt is not None and lt is not True:
        raise TokenError("lt")  # absent, or exactly true: nothing else is a valid value
    tl = payload.get("tl")
    if (lt is True) != (tl is not None):
        raise TokenError("tl")  # live tools without Node's limits, or limits without live tools: refuse
    return Claims(jti=jti, exp=payload["exp"], sub=sub, org=org, max_output_tokens=mo, space=spc, live_tools=lt is True, tool_limits=_parse_tl(tl) if tl is not None else None)


def verify_tool_token(token: str, *, claims: Claims, keys: Mapping[str, str]) -> str:
    """Checks the tool callback token Node sent with a live-tools request and returns it (so the caller keeps one string).

    It must be a genuine Node token (ES256, our key ids) for the callback audience, with the single purpose `tool:execute`
    (a knowledge:authorize token, or one with extra purposes, is refused), bound to THIS request (`rid` = the generate token's
    jti), THIS user and THIS organization, with a bounded lifetime. Node re-checks everything on every call; this only makes
    sure we never hold, or present, a token that was not minted for this very request and purpose.
    """
    if not token or len(token) > 4096:
        raise TokenError("tool_malformed")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise TokenError("tool_malformed") from None
    key = keys.get(header.get("kid") or "")
    if header.get("alg") != "ES256" or key is None:
        raise TokenError("tool_alg_or_kid")
    try:
        payload = jwt.decode(token, key, algorithms=["ES256"], audience=AUD_CALLBACK, issuer=ISSUER, leeway=LEEWAY_SECONDS, options={"require": ["exp", "iat", "nbf", "iss", "aud", "jti", "rid", "sub", "org", "scp"]})
    except jwt.PyJWTError as error:
        raise TokenError(f"tool_{type(error).__name__}") from None
    lifetime = payload["exp"] - payload["iat"]
    if lifetime <= 0 or lifetime > MAX_CALLBACK_LIFETIME_SECONDS:
        raise TokenError("tool_lifetime")
    if payload["scp"] != [SCOPE_TOOL_EXECUTE]:
        raise TokenError("tool_scope")
    if payload["rid"] != claims.jti or payload["sub"] != claims.sub or payload["org"] != claims.org:
        raise TokenError("tool_binding")
    return token
