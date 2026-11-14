"""Request schema for /internal/v1/generate.

Strict by design: unknown fields are rejected, and there are NO identity fields (user, org, role,
permissions). Who is asking comes only from the verified token.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing_extensions import Annotated

MAX_MESSAGES = 200
MAX_CONTENT_CHARS = 400_000
MAX_TOOLS = 128

ToolName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCall(_Strict):
    id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    name: ToolName
    arguments: str | dict[str, Any] | None = None


class Message(_Strict):
    role: Literal["system", "user", "assistant", "tool"]
    content: Annotated[str, StringConstraints(max_length=MAX_CONTENT_CHARS)] | None = None
    toolCalls: list[ToolCall] | None = Field(default=None, max_length=64)
    toolCallId: Annotated[str, StringConstraints(max_length=128)] | None = None
    name: Annotated[str, StringConstraints(max_length=64)] | None = None


class Tool(_Strict):
    name: ToolName
    description: Annotated[str, StringConstraints(max_length=2000)] | None = None
    parameters: dict[str, Any] | None = None


class GenerateRequest(_Strict):
    purpose: Literal["chat", "summarize"] = "chat"
    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)
    tools: list[Tool] | None = Field(default=None, max_length=MAX_TOOLS)
    toolChoice: Literal["auto", "none", "required"] | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
