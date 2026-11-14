import asyncio
import hashlib
import logging
import os

import httpx
import pytest

from app.ingestion.config import WorkerSettings
from app.ingestion.isolate import IsolationError, run_isolated
from app.ingestion.limits import Limits
from app.ingestion.node_client import LockLost, NodeClient, NodeError
from app.ingestion.worker import Worker
from tests import fixtures as fx

SECRET_TEXT = "BOARD-CONFIDENTIAL salary figures for everyone in the company"


class FakeNode:
    """Stands in for NodeClient: records every call."""

    def __init__(self, data: bytes, fmt="txt", sha=None, job=True):
        self.data, self.fmt = data, fmt
        self.sha = sha if sha is not None else hashlib.sha256(data).hexdigest()
        self.job = job
        self.submitted = []
        self.downloads = 0
        self.heartbeats = 0
        self.download_error = None
        self.submit_error = None
        self.paths = []

    async def claim(self, pipeline_version):
        assert pipeline_version == "p2"
        if not self.job:
            return None
        self.job = False
        return {"id": "job1", "lockToken": "tok", "leaseSeconds": 0.3, "format": self.fmt, "sha256": self.sha}

    async def heartbeat(self, job_id, token):
        self.heartbeats += 1

    async def download(self, job_id, token, dest, max_bytes):
        self.downloads += 1
        if self.download_error:
            raise self.download_error
        with open(dest, "wb") as f:
            f.write(self.data)
        self.paths.append(dest)
        return hashlib.sha256(self.data).hexdigest()

    async def submit(self, job_id, token, result):
        if self.submit_error:
            raise self.submit_error
        self.submitted.append(result)
        return {"ok": True}

    async def close(self):
        pass


def settings(tmp_path, tokenizer_path, **limits):
    return WorkerSettings(signing_key_pem="x", tmp_dir=str(tmp_path), limits=Limits(timeout_seconds=20.0, tokenizer_path=tokenizer_path, **limits))


async def run_worker(node, tmp_path, tokenizer_path, **kw):
    w = Worker(settings(tmp_path, tokenizer_path), client=node, **kw)
    return await w.run_once()


async def test_nothing_to_do(tmp_path, tokenizer_path):
    assert await run_worker(FakeNode(b"x", job=False), tmp_path, tokenizer_path) is False


async def test_indexes_a_document_end_to_end(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt(3))
    assert await run_worker(node, tmp_path, tokenizer_path)
    (result,) = node.submitted
    assert result["status"] == "indexed" and result["chunks"] and result["pipelineVersion"] == "p2"


async def test_skips_with_a_reason(tmp_path, tokenizer_path):
    node = FakeNode(fx.blank_pdf(), fmt="pdf")
    await run_worker(node, tmp_path, tokenizer_path)
    assert node.submitted == [{"status": "skipped", "reason": "NO_EXTRACTABLE_TEXT", "format": "pdf", "pipelineVersion": "p2"}]


async def test_checksum_mismatch_is_reported_as_failed_and_nothing_is_extracted(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt(), sha="0" * 64)
    await run_worker(node, tmp_path, tokenizer_path)
    assert node.submitted == [{"status": "failed", "reason": "CHECKSUM_MISMATCH"}]


async def test_download_failure_is_reported_as_failed(tmp_path, tokenizer_path):
    node = FakeNode(b"x")
    node.download_error = NodeError("boom")
    await run_worker(node, tmp_path, tokenizer_path)
    assert node.submitted == [{"status": "failed", "reason": "DOWNLOAD_FAILED"}]


async def test_lock_lost_on_download_submits_nothing(tmp_path, tokenizer_path):
    node = FakeNode(b"x")
    node.download_error = LockLost()
    await run_worker(node, tmp_path, tokenizer_path)
    assert node.submitted == []


async def test_lock_lost_on_submit_is_quiet(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt())
    node.submit_error = LockLost()
    assert await run_worker(node, tmp_path, tokenizer_path)


async def test_crash_and_timeout_are_reported_as_failed_with_codes(tmp_path, tokenizer_path):
    for reason in ("EXTRACTION_CRASHED", "EXTRACTION_TIMEOUT", "EXTRACTION_OOM"):
        node = FakeNode(fx.make_txt())

        def runner(target, args, limits, reason=reason):
            raise IsolationError(reason)

        await run_worker(node, tmp_path, tokenizer_path, runner=runner)
        assert node.submitted == [{"status": "failed", "reason": reason}]


async def test_unexpected_errors_become_internal_error_without_leaking(tmp_path, caplog, tokenizer_path):
    node = FakeNode(fx.make_txt())

    def runner(*a, **k):
        raise RuntimeError(SECRET_TEXT)

    caplog.set_level(logging.DEBUG)
    await run_worker(node, tmp_path, tokenizer_path, runner=runner)
    assert node.submitted == [{"status": "failed", "reason": "INTERNAL_ERROR"}]
    assert SECRET_TEXT not in caplog.text


async def test_temp_file_is_always_removed(tmp_path, tokenizer_path):
    for case in ("ok", "crash", "lost"):
        node = FakeNode(fx.make_txt())
        if case == "lost":
            node.download_error = LockLost()
        runner = (lambda *a, **k: (_ for _ in ()).throw(IsolationError("EXTRACTION_CRASHED"))) if case == "crash" else run_isolated
        await run_worker(node, tmp_path, tokenizer_path, runner=runner)
    assert os.listdir(tmp_path) == []


async def test_temp_file_is_private(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt())
    seen = {}

    def runner(target, args, limits):
        seen["mode"] = os.stat(args[1]).st_mode & 0o777
        return run_isolated(target, args, limits)

    await run_worker(node, tmp_path, tokenizer_path, runner=runner)
    assert seen["mode"] == 0o600


async def test_heartbeats_keep_the_lease_alive_while_extracting(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt())

    def slow(target, args, limits):
        import time

        time.sleep(0.6)
        return run_isolated(target, args, limits)

    await run_worker(node, tmp_path, tokenizer_path, runner=slow)
    assert node.heartbeats >= 1


async def test_heartbeat_losing_the_lock_suppresses_the_submit(tmp_path, tokenizer_path):
    node = FakeNode(fx.make_txt())

    async def lost(job_id, token):
        raise LockLost()

    node.heartbeat = lost

    def slow(target, args, limits):
        import time

        time.sleep(0.6)
        return run_isolated(target, args, limits)

    await run_worker(node, tmp_path, tokenizer_path, runner=slow)
    assert node.submitted == []  # someone else owns the job now; do not overwrite their result


async def test_logs_contain_ids_and_codes_only(tmp_path, caplog, tokenizer_path):
    caplog.set_level(logging.DEBUG)
    node = FakeNode((SECRET_TEXT + "\n\n").encode() * 20)
    await run_worker(node, tmp_path, tokenizer_path)
    node2 = FakeNode(b"\x00\x01binary" * 100)
    await run_worker(node2, tmp_path, tokenizer_path)
    assert SECRET_TEXT not in caplog.text and "BOARD" not in caplog.text
    assert "job=job1" in caplog.text and "outcome=indexed" in caplog.text


# ---- NodeClient: auth and transport ------------------------------------------------------------------

def make_key():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    k = ec.generate_private_key(ec.SECP256R1())
    return (
        k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
        k.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
    )


async def test_client_sends_a_fresh_es256_token_each_call_and_maps_status_codes():
    import jwt

    priv, pub = make_key()
    seen = []

    def handler(request: httpx.Request):
        token = request.headers["authorization"].split()[1]
        seen.append(jwt.decode(token, pub, algorithms=["ES256"], audience="syncos-node:ingestion", issuer="syncos-ai-worker"))
        path = request.url.path
        if path.endswith("/claim"):
            return httpx.Response(200, json={"job": None})
        if path.endswith("/heartbeat"):
            return httpx.Response(409, json={})
        if path.endswith("/content"):
            return httpx.Response(200, content=b"abc")
        return httpx.Response(500)

    s = WorkerSettings(signing_key_pem=priv, key_id="w1", worker_id="w-test")
    c = NodeClient(s, http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await c.claim("p1") is None
    with pytest.raises(LockLost):
        await c.heartbeat("j", "t")
    with pytest.raises(NodeError):
        await c.submit("j", "t", {})
    assert len({p["jti"] for p in seen}) == 3 and all(p["sub"] == "w-test" and p["exp"] - p["iat"] <= 30 for p in seen)


async def test_client_download_is_size_capped_and_hashed(tmp_path, tokenizer_path):
    priv, _ = make_key()
    s = WorkerSettings(signing_key_pem=priv)
    c = NodeClient(s, http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 1000))))
    assert await c.download("j", "t", str(tmp_path / "ok"), 2000) == hashlib.sha256(b"x" * 1000).hexdigest()
    with pytest.raises(NodeError):
        await c.download("j", "t", str(tmp_path / "big"), 500)


def test_startup_sweep_removes_only_old_ingest_files(tmp_path):
    import time

    from app.ingestion.worker import sweep_stale_temp_files

    old, fresh, other = tmp_path / "ingest-old", tmp_path / "ingest-fresh", tmp_path / "unrelated.txt"
    for f in (old, fresh, other):
        f.write_bytes(b"x")
    past = time.time() - 3600
    os.utime(old, (past, past))
    os.utime(other, (past, past))
    (tmp_path / "ingest-dir").mkdir()
    os.symlink(other, tmp_path / "ingest-link")
    os.utime(tmp_path / "ingest-link", (past, past), follow_symlinks=False)
    assert sweep_stale_temp_files(str(tmp_path)) == 1
    assert sorted(os.listdir(tmp_path)) == ["ingest-dir", "ingest-fresh", "ingest-link", "unrelated.txt"]
    assert sweep_stale_temp_files(str(tmp_path / "missing")) == 0
