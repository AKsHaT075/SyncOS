import asyncio

import pytest

from app.core.replay import MemoryReplayGuard, RedisReplayGuard, ReplayStoreUnavailable


async def test_memory_guard_allows_first_use_only():
    g = MemoryReplayGuard()
    assert await g.consume("abc", 30) is True
    assert await g.consume("abc", 30) is False
    assert await g.consume("other", 30) is True


async def test_memory_guard_concurrent_consumers_exactly_one_wins():
    g = MemoryReplayGuard()
    results = await asyncio.gather(*[g.consume("same", 30) for _ in range(200)])
    assert results.count(True) == 1


class FakeRedis:
    """Mimics SET NX EX semantics: one shared store, so two 'replicas' see each other."""

    def __init__(self, store=None, fail=False):
        self.store = {} if store is None else store
        self.fail = fail
        self.calls = []

    async def set(self, key, value, nx=False, ex=None):
        self.calls.append((key, nx, ex))
        if self.fail:
            raise ConnectionError("boom")
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def ping(self):
        if self.fail:
            raise ConnectionError()
        return True

    async def aclose(self):
        pass


async def test_redis_guard_uses_atomic_set_nx_ex_with_prefix():
    r = FakeRedis()
    g = RedisReplayGuard("", "pfx", client=r)
    assert await g.consume("jti1", 45) is True
    assert r.calls == [("pfx:jti:jti1", True, 45)]


async def test_redis_guard_is_shared_across_replicas():
    shared = {}
    a, b = RedisReplayGuard("", "p", client=FakeRedis(shared)), RedisReplayGuard("", "p", client=FakeRedis(shared))
    assert await a.consume("x", 30) is True
    assert await b.consume("x", 30) is False  # a different replica cannot replay it


async def test_redis_guard_fails_closed_when_redis_is_down():
    g = RedisReplayGuard("", "p", client=FakeRedis(fail=True))
    with pytest.raises(ReplayStoreUnavailable):
        await g.consume("x", 30)
    assert await g.ping() is False
