"""Node's internal embedding endpoints. Same authentication as ingestion, but its OWN audience."""
from __future__ import annotations

import httpx

from ..ingestion.auth import EMBEDDING_AUDIENCE
from ..ingestion.node_client import LockLost, NodeClient, NodeError


class EmbeddingNodeClient(NodeClient):
    audience = EMBEDDING_AUDIENCE

    async def claim_embedding(self, space_id: str, ingestion_pipeline: str) -> dict | None:
        r = self._check(await self.http.post(f"{self.s.node_url}/internal/embedding/claim", headers=self._headers(), json={"spaceId": space_id, "ingestionPipeline": ingestion_pipeline}))
        return r.json().get("job")

    async def heartbeat_embedding(self, job_id: str, lock_token: str) -> None:
        self._check(await self.http.post(f"{self.s.node_url}/internal/embedding/jobs/{job_id}/heartbeat", headers=self._headers(), json={"lockToken": lock_token}))

    async def chunks(self, job_id: str, lock_token: str, after: int, limit: int) -> dict:
        r = self._check(await self.http.get(f"{self.s.node_url}/internal/embedding/jobs/{job_id}/chunks", params={"after": after, "limit": limit}, headers=self._headers({"X-Lock-Token": lock_token})))
        return r.json()

    async def submit_embedding(self, job_id: str, lock_token: str, result: dict) -> dict:
        r = self._check(await self.http.post(f"{self.s.node_url}/internal/embedding/jobs/{job_id}/result", headers=self._headers(), json={"lockToken": lock_token, "result": result}, timeout=httpx.Timeout(60.0, connect=5.0)))
        return r.json()


__all__ = ["EmbeddingNodeClient", "LockLost", "NodeError"]
