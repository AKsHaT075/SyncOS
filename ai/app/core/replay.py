"""Single-use enforcement for generate tokens (`jti`).

consume() is atomic and returns False for a jti that was already seen within its lifetime.
Redis is the default and is correct across any number of replicas. The in-memory store is
only valid for exactly one process, and config.validate_settings refuses it unless the
operator confirms that with AI_SINGLE_INSTANCE=true.
"""
from __future__ import annotations

import time
from typing import Protocol

from .config import Settings


class ReplayStoreUnavailable(Exception):
    """The store cannot prove single use. The request must be refused (fail closed)."""


class ReplayGuard(Protocol):
    name: str

    async def consume(self, jti: str, ttl_seconds: int) -> bool: ...

    async def ping(self) -> bool: ...

    async def close(self) -> None: ...


class MemoryReplayGuard:
    name = "memory"

    def __init__(self, clock=time.monotonic) -> None:
        self._seen: dict[str, float] = {}
        self._clock = clock

    async def consume(self, jti: str, ttl_seconds: int) -> bool:
        now = self._clock()
        if len(self._seen) > 10_000:  # opportunistic prune; entries expire with their token anyway
            self._seen = {k: v for k, v in self._seen.items() if v > now}
        if self._seen.get(jti, 0) > now:
            return False
        self._seen[jti] = now + ttl_seconds  # single-threaded event loop: check-and-set cannot interleave
        return True

    async def ping(self) -> bool:
        return True

    async def close(self) -> None:
        return None


class RedisReplayGuard:
    name = "redis"

    def __init__(self, url: str, prefix: str, client=None) -> None:
        if client is None:
            import redis.asyncio as redis_asyncio

            client = redis_asyncio.from_url(url, socket_connect_timeout=2, socket_timeout=2)
        self._client = client
        self._prefix = prefix

    async def consume(self, jti: str, ttl_seconds: int) -> bool:
        try:
            # SET NX EX is one atomic command: exactly one caller can ever get OK for a given jti.
            created = await self._client.set(f"{self._prefix}:jti:{jti}", "1", nx=True, ex=max(1, int(ttl_seconds)))
        except Exception:
            raise ReplayStoreUnavailable() from None
        return bool(created)

    async def ping(self) -> bool:
        try:
            return bool(await self._client.ping())
        except Exception:
            return False

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass


def build_replay_guard(settings: Settings) -> ReplayGuard:
    if settings.replay_store == "memory":
        return MemoryReplayGuard()
    return RedisReplayGuard(settings.redis_url, settings.redis_prefix)
