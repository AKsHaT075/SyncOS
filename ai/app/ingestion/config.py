from __future__ import annotations

import base64
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from ..core.config import ConfigError
from .limits import Limits
from .sizer import SizerUnavailable, build_sizer


@dataclass(frozen=True)
class WorkerSettings:
    node_url: str = "http://127.0.0.1:5002"
    signing_key_pem: str = ""
    key_id: str = "w1"
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}-{os.getpid()}")
    poll_seconds: float = 3.0
    tmp_dir: str | None = None
    limits: Limits = field(default_factory=Limits)


def _int(env: Mapping[str, str], name: str, default: int, minimum: int = 1) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if value < minimum:
        raise ConfigError(f"{name} is out of range")
    return value


def load_signing_key_pem(env: Mapping[str, str]) -> str:
    """The worker's ES256 PRIVATE key (shared by the ingestion and embedding workers). Validated; never logged."""
    pem = env.get("AI_WORKER_SIGNING_KEY", "")
    path = env.get("AI_WORKER_SIGNING_KEY_FILE", "").strip()
    if path:
        try:
            pem = Path(path).read_text()
        except OSError:
            raise ConfigError("AI_WORKER_SIGNING_KEY_FILE cannot be read") from None
    pem = pem.strip().replace("\\n", "\n")
    if pem and "BEGIN" not in pem:
        try:
            pem = base64.b64decode(pem, validate=True).decode()
        except Exception:
            raise ConfigError("AI_WORKER_SIGNING_KEY is neither a PEM nor base64 of a PEM") from None
    if not pem:
        raise ConfigError("no worker signing key configured (AI_WORKER_SIGNING_KEY / AI_WORKER_SIGNING_KEY_FILE)")
    try:
        key = load_pem_private_key(pem.encode(), password=None)
    except Exception:
        raise ConfigError("worker signing key is not a valid unencrypted PEM") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ConfigError("worker signing key must be an EC P-256 key (ES256)")
    return pem


def load_worker_settings(env: Mapping[str, str] | None = None) -> WorkerSettings:
    env = os.environ if env is None else env
    pem = load_signing_key_pem(env)

    node_url = (env.get("AI_NODE_INTERNAL_URL", "").strip() or "http://127.0.0.1:5002").rstrip("/")
    defaults = Limits()
    tokenizer_path = env.get("AI_CHUNK_TOKENIZER_FILE", "").strip() or None
    if tokenizer_path is None:
        # The chunker sizes with the embedding model's own tokenizer. Resolve it from the pinned snapshot (cached
        # after the first download; AI_EMBEDDING_OFFLINE=true forbids any network access).
        from ..embeddings.fastembed_provider import EmbeddingConfig, snapshot_dir
        from ..embeddings.provider import ModelUnavailable
        from ..embeddings.spec import E5_SMALL

        try:
            root = snapshot_dir(E5_SMALL, EmbeddingConfig(cache_dir=env.get("AI_EMBEDDING_CACHE_DIR", "").strip() or None, offline=env.get("AI_EMBEDDING_OFFLINE", "").strip().lower() in {"1", "true", "yes"}, model_path=env.get("AI_EMBEDDING_MODEL_PATH", "").strip() or None))
        except ModelUnavailable:
            raise ConfigError("the chunking tokenizer is unavailable (set AI_CHUNK_TOKENIZER_FILE, or make the embedding model files available)") from None
        tokenizer_path = str(root / "tokenizer.json")
    try:
        build_sizer(tokenizer_path)
    except SizerUnavailable:
        raise ConfigError("the chunking tokenizer cannot be loaded") from None
    limits = Limits(
        tokenizer_path=tokenizer_path,
        max_file_bytes=_int(env, "AI_INGEST_MAX_FILE_MB", defaults.max_file_bytes // (1024 * 1024)) * 1024 * 1024,
        max_text_chars=_int(env, "AI_INGEST_MAX_TEXT_CHARS", defaults.max_text_chars),
        timeout_seconds=float(_int(env, "AI_INGEST_TIMEOUT_SECONDS", int(defaults.timeout_seconds))),
        cpu_seconds=_int(env, "AI_INGEST_CPU_SECONDS", defaults.cpu_seconds),
        memory_bytes=_int(env, "AI_INGEST_MEMORY_MB", defaults.memory_bytes // (1024 * 1024)) * 1024 * 1024,
    )
    return WorkerSettings(
        node_url=node_url,
        signing_key_pem=pem,
        key_id=env.get("AI_WORKER_KEY_ID", "").strip() or "w1",
        worker_id=env.get("AI_WORKER_ID", "").strip() or f"{socket.gethostname()}-{os.getpid()}",
        poll_seconds=float(_int(env, "AI_INGEST_POLL_SECONDS", 3)),
        tmp_dir=env.get("AI_INGEST_TMP_DIR", "").strip() or None,
        limits=limits,
    )
