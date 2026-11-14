"""HTTP client for Node's internal ingestion endpoints. Never logs bodies, headers or tokens."""
from __future__ import annotations

import hashlib
from typing import AsyncIterator

import httpx

from .auth import AUDIENCE, sign_worker_token
from .config import WorkerSettings


class LockLost(Exception):
    """Node says this job is no longer ours (lease expired, superseded, document deleted). Stop quietly."""


class NodeError(Exception):
    pass


class NodeClient:
    audience = AUDIENCE  # subclasses for other worker kinds change this and nothing else about authentication

    def __init__(self, settings: WorkerSettings, http: httpx.AsyncClient | None = None) -> None:
        self.s = settings
        self.http = http or httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0))
        self._owns = http is None

    async def close(self) -> None:
        if self._owns:
            await self.http.aclose()

    def _headers(self, extra: dict | None = None) -> dict:
        return {"Authorization": f"Bearer {sign_worker_token(self.s.signing_key_pem, self.s.key_id, self.s.worker_id, self.audience)}", **(extra or {})}

    def _check(self, response: httpx.Response) -> httpx.Response:
        if response.status_code in (404, 409, 410):
            raise LockLost()
        if response.status_code >= 400:
            raise NodeError(f"node {response.status_code}")
        return response

    async def claim(self, pipeline_version: str) -> dict | None:
        r = self._check(await self.http.post(f"{self.s.node_url}/internal/ingestion/claim", headers=self._headers(), json={"workerId": self.s.worker_id, "pipelineVersion": pipeline_version}))
        return r.json().get("job")

    async def heartbeat(self, job_id: str, lock_token: str) -> None:
        self._check(await self.http.post(f"{self.s.node_url}/internal/ingestion/jobs/{job_id}/heartbeat", headers=self._headers(), json={"lockToken": lock_token}))

    async def download(self, job_id: str, lock_token: str, dest_path: str, max_bytes: int) -> str:
        """Streams the authorized bytes to dest_path (size-capped) and returns their sha256."""
        digest, size = hashlib.sha256(), 0
        async with self.http.stream("GET", f"{self.s.node_url}/internal/ingestion/jobs/{job_id}/content", headers=self._headers({"X-Lock-Token": lock_token})) as response:
            if response.status_code in (404, 409, 410):
                raise LockLost()
            if response.status_code >= 400:
                raise NodeError(f"node {response.status_code}")
            with open(dest_path, "wb") as out:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise NodeError("content exceeds limit")
                    digest.update(chunk)
                    out.write(chunk)
        return digest.hexdigest()

    async def submit(self, job_id: str, lock_token: str, result: dict) -> dict:
        r = self._check(await self.http.post(f"{self.s.node_url}/internal/ingestion/jobs/{job_id}/result", headers=self._headers(), json={"lockToken": lock_token, "result": result}, timeout=httpx.Timeout(120.0, connect=5.0)))
        return r.json()
