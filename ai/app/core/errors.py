"""Normalized provider errors. These (and only these) cross the provider boundary.

Messages are generic on purpose: upstream error text can echo prompt content, so it is never kept.
"""
from __future__ import annotations

NOT_CONFIGURED = "AI_NOT_CONFIGURED"
RATE_LIMITED = "AI_PROVIDER_RATE_LIMITED"
TIMEOUT = "AI_PROVIDER_TIMEOUT"
UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE"
AUTH = "AI_PROVIDER_AUTH"
CONTEXT_TOO_LONG = "AI_CONTEXT_TOO_LONG"
CONTENT_FILTERED = "AI_CONTENT_FILTERED"
TOOL_ERROR = "AI_PROVIDER_TOOL_ERROR"
BAD_REQUEST = "AI_PROVIDER_BAD_REQUEST"
ABORTED = "AI_REQUEST_ABORTED"
INVALID_RESPONSE = "AI_PROVIDER_INVALID_RESPONSE"
RETRIEVAL_UNAVAILABLE = "AI_RETRIEVAL_UNAVAILABLE"  # embedding, vector search or Node authorization failed: no answer is given


class ProviderError(Exception):
    def __init__(
        self,
        code: str,
        *,
        retryable: bool = False,
        retry_after_ms: int | None = None,
        upstream_status: int | None = None,
        stream_started: bool = False,
        upstream_code: str | None = None,
    ) -> None:
        super().__init__(code)  # the code only: str(error) can never carry content
        self.code = code
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.upstream_status = upstream_status
        self.stream_started = stream_started
        self.upstream_code = upstream_code  # Groq's machine-readable error code (e.g. tool_use_failed), for logs only; never message text

    def frame(self) -> dict:
        return {
            "type": "error",
            "code": self.code,
            "retryable": self.retryable,
            "streamStarted": self.stream_started,
            "upstreamStatus": self.upstream_status,
        }
