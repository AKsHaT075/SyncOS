"""Everything a request needs to run live tools, bundled once the route has verified BOTH authorization signals (the signed `lt` claim and a tool token
minted for this request)."""
from __future__ import annotations

from dataclasses import dataclass
import httpx

from ..core.config import Settings
from .config import ToolSettings


@dataclass(frozen=True)
class ToolContext:
    http: httpx.AsyncClient
    token: str  # the tool:execute callback token (never shown to the model)
    settings: Settings
    limits: ToolSettings  # Node's limits applied: this process may only be stricter
