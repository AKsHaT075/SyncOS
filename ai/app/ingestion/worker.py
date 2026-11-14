"""The ingestion worker: `python -m app.ingestion.worker [--once]`. A separate process from the API.

claim (Node) -> download authorized bytes (Node) -> isolated extraction -> submit result (Node).
It holds no database or storage access and no Groq key. Logs carry job ids, codes and counts only.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import signal
import sys
import tempfile
import time

from . import PIPELINE_VERSION
from .config import WorkerSettings, load_worker_settings
from .isolate import IsolationError, run_isolated
from .node_client import LockLost, NodeClient, NodeError
from .pipeline import process_file
from .reasons import CHECKSUM_MISMATCH, DOWNLOAD_FAILED, INTERNAL

log = logging.getLogger("ai.worker")

TEMP_PREFIX = "ingest-"
STALE_TEMP_SECONDS = 900


def sweep_stale_temp_files(directory: str | None, max_age_seconds: int = STALE_TEMP_SECONDS) -> int:
    """A worker killed by SIGKILL/OOM cannot clean up, and its temp file holds a downloaded document. Remove the
    leftovers of OUR files (prefix match, regular files only, older than max_age) when a worker starts."""
    directory = directory or tempfile.gettempdir()
    removed = 0
    try:
        names = os.listdir(directory)
    except OSError:
        return 0
    cutoff = time.time() - max_age_seconds
    for name in names:
        if not name.startswith(TEMP_PREFIX):
            continue
        path = os.path.join(directory, name)
        try:
            if os.path.isfile(path) and not os.path.islink(path) and os.stat(path).st_mtime < cutoff:
                os.unlink(path)
                removed += 1
        except OSError:
            continue
    return removed


class Worker:
    def __init__(self, settings: WorkerSettings, client: NodeClient | None = None, runner=run_isolated) -> None:
        self.s = settings
        self.client = client or NodeClient(settings)
        self.runner = runner
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run_once(self) -> bool:
        """Claims and fully handles at most one job. Returns False when there was nothing to do."""
        try:
            job = await self.client.claim(PIPELINE_VERSION)
        except (NodeError, LockLost, OSError) as error:
            log.warning("claim failed: %s", type(error).__name__)
            return False
        except Exception as error:  # httpx transport errors
            log.warning("claim failed: %s", type(error).__name__)
            return False
        if not job:
            return False
        await self._handle(job)
        return True

    async def _handle(self, job: dict) -> None:
        job_id, token = job["id"], job["lockToken"]
        started = time.monotonic()
        fd, path = tempfile.mkstemp(prefix=TEMP_PREFIX, dir=self.s.tmp_dir)
        os.close(fd)
        os.chmod(path, 0o600)
        lost = asyncio.Event()
        beat = asyncio.create_task(self._heartbeat(job_id, token, float(job.get("leaseSeconds", 120)), lost))
        outcome = "?"
        try:
            try:
                sha = await self.client.download(job_id, token, path, self.s.limits.max_file_bytes)
            except LockLost:
                outcome = "lock_lost"
                return
            except Exception as error:
                outcome = "download_failed"
                log.warning("job=%s download failed: %s", job_id, type(error).__name__)
                await self._submit(job_id, token, {"status": "failed", "reason": DOWNLOAD_FAILED})
                return
            if sha != job.get("sha256"):
                outcome = "checksum_mismatch"
                await self._submit(job_id, token, {"status": "failed", "reason": CHECKSUM_MISMATCH})
                return
            try:
                result = await asyncio.to_thread(self.runner, process_file, (job["format"], path, self.s.limits.as_dict(), sha), self.s.limits)
            except IsolationError as error:
                outcome = f"failed:{error.reason}"
                result = {"status": "failed", "reason": error.reason}
            except Exception as error:
                outcome = "failed:internal"
                log.error("job=%s unexpected: %s", job_id, type(error).__name__)
                result = {"status": "failed", "reason": INTERNAL}
            if lost.is_set():
                outcome = "lock_lost"
                return
            if await self._submit(job_id, token, result):
                outcome = result["status"] + (f":{result.get('reason')}" if result.get("reason") else "")
            else:
                outcome = "lock_lost"
        finally:
            beat.cancel()
            try:
                os.unlink(path)  # the downloaded document never outlives the job
            except OSError:
                pass
            log.info("job=%s outcome=%s ms=%d", job_id, outcome, (time.monotonic() - started) * 1000)

    async def _submit(self, job_id: str, token: str, result: dict) -> bool:
        try:
            await self.client.submit(job_id, token, result)
            return True
        except LockLost:
            return False
        except Exception as error:
            log.warning("job=%s submit failed: %s", job_id, type(error).__name__)
            return False  # the lease will expire and Node will retry

    async def _heartbeat(self, job_id: str, token: str, lease: float, lost: asyncio.Event) -> None:
        try:
            while True:
                await asyncio.sleep(max(0.05, lease / 3))
                try:
                    await self.client.heartbeat(job_id, token)
                except LockLost:
                    lost.set()
                    return
                except Exception:
                    pass  # transient; the next beat may succeed
        except asyncio.CancelledError:
            return

    async def run_forever(self) -> None:
        log.info("worker %s started (pipeline %s)", self.s.worker_id, PIPELINE_VERSION)
        while not self._stop.is_set():
            did = await self.run_once()
            if not did:
                try:
                    await asyncio.wait_for(self._stop.wait(), self.s.poll_seconds * (0.8 + random.random() * 0.4))
                except asyncio.TimeoutError:
                    pass
        await self.client.close()


async def _main(once: bool) -> int:
    settings = load_worker_settings()
    swept = sweep_stale_temp_files(settings.tmp_dir)
    if swept:
        log.info("removed %d stale temp file(s) left by a crashed worker", swept)
    worker = Worker(settings)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, worker.stop)
    if once:
        while await worker.run_once():
            pass
        await worker.client.close()
        return 0
    await worker.run_forever()
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    sys.exit(asyncio.run(_main("--once" in sys.argv)))


if __name__ == "__main__":
    main()
