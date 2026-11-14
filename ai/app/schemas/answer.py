"""Request schema for /internal/v1/answer: a question and nothing else. Identity, organization, the embedding space and the
callback token all come from signed material (see api/routes.py), never from the body."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing_extensions import Annotated


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20000)]
    history: "list[Turn]" = Field(default_factory=list, max_length=6)


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


# Optional earlier turns of the SAME conversation, chosen and trimmed by Node. Used only to make a follow-up searchable (rag/condense.py).
AnswerRequest.model_rebuild()
