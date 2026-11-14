"""The embedding worker: `python -m app.embeddings.worker [--once]`. A separate process from the API and from the
ingestion worker.

claim (Node) -> fetch authorized chunk text (Node) -> embed (local model, loaded once) -> write vectors (Qdrant) ->
report counts (Node). It holds a Qdrant config and the worker key; no database, no Groq key. Every Qdrant operation
uses the organization Node gave it with the job. Logs carry job ids, codes and counts only - never text or vectors.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import signal
import sys
import time

from ..ingestion.node_client import LockLost, NodeError
from ..vectorstore.base import DimensionMismatch, InvalidVector, StoreUnavailable, VectorItem, VectorStoreError
from ..vectorstore.config import build_store
from .config import EmbeddingWorkerSettings, load_embedding_worker_settings
from .factory import get_provider
from .node_client import EmbeddingNodeClient
from .provider import EmbeddingError, EmbeddingProvider

log = logging.getLogger("ai.embedding-worker")

# reason codes (mirrored in ai/contracts/embedding.json and Node's embedding.constants.js)
QDRANT_UNAVAILABLE = "VECTOR_STORE_UNAVAILABLE"
INTERNAL = "INTERNAL_ERROR"
COUNT_MISMATCH = "VECTOR_COUNT_MISMATCH"
NODE_UNAVAILABLE = "NODE_UNAVAILABLE"


class Worker:
    def __init__(self, settings: EmbeddingWorkerSettings, provider: EmbeddingProvider, store, client: EmbeddingNodeClient | None = None) -> None:
        self.s = settings
        self.provider = provider
        self.store = store
        self.client = client or EmbeddingNodeClient(settings)  # type: ignore[arg-type]
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run_once(self) -> bool:
        try:
            job = await self.client.claim_embedding(self.provider.space_id, self.s.ingestion_pipeline)
        except Exception as error:
            log.warning("claim failed: %s", type(error).__name__)
            return False
        if not job:
            return False
        await self._handle(job)
        return True

    async def _handle(self, job: dict) -> None:
        job_id, token = job["id"], job["lockToken"]
        started = time.monotonic()
        lost = asyncio.Event()
        beat = asyncio.create_task(self._heartbeat(job_id, token, float(job.get("leaseSeconds", 120)), lost))
        outcome = "?"
        try:
            try:
                result = await (self._purge(job) if job["kind"] == "purge" else self._embed(job, lost))
            except LockLost:
                outcome = "lock_lost"
                return
            except EmbeddingError as error:
                result = {"status": "failed", "reason": error.code}
            except (StoreUnavailable, DimensionMismatch, InvalidVector, VectorStoreError) as error:
                result = {"status": "failed", "reason": error.code}
            except NodeError:
                result = {"status": "failed", "reason": NODE_UNAVAILABLE}
            except Exception as error:  # a bug on our side; the class name is all that is safe to log
                log.error("job=%s unexpected: %s", job_id, type(error).__name__)
                result = {"status": "failed", "reason": INTERNAL}
            if lost.is_set():
                outcome = "lock_lost"
                return
            try:
                await self.client.submit_embedding(job_id, token, result)
                outcome = result["status"] + (f":{result['reason']}" if result.get("reason") else "")
            except LockLost:
                outcome = "lock_lost"
            except Exception as error:
                outcome = "submit_failed"
                log.warning("job=%s submit failed: %s", job_id, type(error).__name__)  # the lease lapses and Node retries
        finally:
            beat.cancel()
            log.info("job=%s kind=%s outcome=%s ms=%d", job_id, job.get("kind"), outcome, (time.monotonic() - started) * 1000)

    async def _heartbeat(self, job_id: str, token: str, lease: float, lost: asyncio.Event) -> None:
        try:
            while True:
                await asyncio.sleep(max(0.05, lease / 3))
                try:
                    await self.client.heartbeat_embedding(job_id, token)
                except LockLost:
                    lost.set()
                    return
                except Exception:
                    pass
        except asyncio.CancelledError:
            return

    # ------------------------------------------------------------------ purge

    async def _purge(self, job: dict) -> dict:
        deleted = await asyncio.to_thread(
            self.store.delete_document,
            organization=job["organization"],
            document=job["document"],
            space_id=job["spaceId"],
            keep_version=job.get("keepVersion"),
        )
        return {"status": "completed", "deleted": int(deleted), "generation": job.get("generation", 0)}

    # ------------------------------------------------------------------ embed

    async def _fetch_chunks(self, job: dict) -> list[dict]:
        chunks: list[dict] = []
        after = -1
        while True:
            page = await self.client.chunks(job["id"], job["lockToken"], after, self.s.page_size)
            batch = page.get("chunks", [])
            chunks.extend(batch)
            after = page.get("next")
            if after is None or not batch:
                return chunks

    async def _embed(self, job: dict, lost: asyncio.Event) -> dict:
        org, doc, version, pipe, space = job["organization"], job["document"], job["version"], job["ingestionPipeline"], job["spaceId"]
        if space != self.provider.space_id:  # Node must never hand us a job for a space we cannot produce
            return {"status": "failed", "reason": INTERNAL}
        chunks = await self._fetch_chunks(job)
        n = len(chunks)
        if [c["index"] for c in chunks] != list(range(n)) or n == 0:
            return {"status": "failed", "reason": INTERNAL}

        await asyncio.to_thread(self.store.ensure_collection, space, self.provider.dimensions)
        existing = await asyncio.to_thread(self.store.indexed_hashes, organization=org, document=doc, version=version, ingestion_pipeline=pipe, space_id=space)

        stale = [i for i in existing if i >= n or i < 0]
        if stale:
            await asyncio.to_thread(self.store.delete_chunks, organization=org, document=doc, version=version, ingestion_pipeline=pipe, space_id=space, chunk_indexes=stale)

        todo = [c for c in chunks if existing.get(c["index"]) != c["textHash"]]  # unchanged chunks are not re-embedded
        for start in range(0, len(todo), self.s.batch_size):
            if lost.is_set():
                raise LockLost()
            batch = todo[start : start + self.s.batch_size]
            vectors = await asyncio.to_thread(self.provider.embed_passages, [c["text"] for c in batch])
            items = [VectorItem(c["index"], c["textHash"], vectors[i]) for i, c in enumerate(batch)]
            await asyncio.to_thread(self.store.upsert, organization=org, document=doc, version=version, ingestion_pipeline=pipe, space_id=space, items=items)

        stored = await asyncio.to_thread(self.store.count, organization=org, document=doc, space_id=space, version=version)
        if stored != n:  # other versions' points do not count here: this is exactly this version's set
            return {"status": "failed", "reason": COUNT_MISMATCH}
        digest = hashlib.sha256("\n".join(c["textHash"] for c in chunks).encode()).hexdigest()
        return {
            "status": "embedded",
            "spaceId": space,
            "model": self.provider.descriptor["model"],
            "revision": self.provider.descriptor["revision"],
            "dimensions": self.provider.dimensions,
            "count": n,
            "digest": digest,
            "embedded": len(todo),
        }

    async def run_forever(self) -> None:
        log.info("embedding worker %s started space=%s dims=%d store=%s", self.s.worker_id, self.provider.space_id, self.provider.dimensions, self.s.vectorstore.mode)
        while not self._stop.is_set():
            if not await self.run_once():
                try:
                    await asyncio.wait_for(self._stop.wait(), self.s.poll_seconds * (0.8 + random.random() * 0.4))
                except asyncio.TimeoutError:
                    pass
        await self.client.close()


async def _main(once: bool) -> int:
    settings = load_embedding_worker_settings()
    try:
        provider = get_provider(settings.embedding, settings.ingestion_pipeline)  # loaded ONCE; fails fast if unusable
        store = build_store(settings.vectorstore)
        store.ensure_collection(provider.space_id, provider.dimensions)
    except (EmbeddingError, VectorStoreError) as error:
        log.error("embedding worker cannot start: %s", error.code)
        return 2
    worker = Worker(settings, provider, store)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, worker.stop)
    if once:
        while await worker.run_once():
            pass
        await worker.client.close()
        store.close()
        return 0
    await worker.run_forever()
    store.close()
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    sys.exit(asyncio.run(_main("--once" in sys.argv)))


if __name__ == "__main__":
    main()
