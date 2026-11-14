"""Settings, read once from the environment. No global state: tests build their own Settings."""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Mapping

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_pem_public_key

if TYPE_CHECKING:  # pragma: no cover
    from ..rag.config import RagSettings
    from ..tools.config import ToolSettings

VERSION = "1.1.0"
PURPOSES = ("chat", "summarize")


def _default_rag():
    from ..rag.config import RagSettings

    return RagSettings()


def _default_tools():
    from ..tools.config import ToolSettings

    return ToolSettings()


class ConfigError(RuntimeError):
    """Raised at startup for an unsafe or unusable configuration. Messages never contain secrets."""


@dataclass(frozen=True)
class Settings:
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    model_chat: str = "openai/gpt-oss-120b"
    model_summarize: str = "openai/gpt-oss-120b"
    request_timeout_ms: int = 90_000  # whole attempt, stream included
    first_byte_timeout_ms: int = 20_000  # until the first stream event
    stream_idle_timeout_ms: int = 30_000  # silence between chunks
    max_retries: int = 2
    max_output_tokens: int = 2048
    backoff_base_ms: int = 400
    backoff_max_ms: int = 8_000
    retry_after_max_ms: int = 10_000
    max_body_bytes: int = 2 * 1024 * 1024
    jwt_public_keys: Mapping[str, str] = field(default_factory=dict)  # kid -> PEM
    replay_store: str = "redis"  # "redis" | "memory"
    single_instance: bool = False
    redis_url: str = "redis://127.0.0.1:6379"
    redis_prefix: str = "ai-service"
    host: str = "127.0.0.1"
    port: int = 8001
    rag: "RagSettings" = field(default_factory=lambda: _default_rag())
    tools: "ToolSettings" = field(default_factory=lambda: _default_tools())

    @property
    def configured(self) -> bool:
        return bool(self.groq_api_key)

    def model_for(self, purpose: str) -> str:
        return {"chat": self.model_chat, "summarize": self.model_summarize}[purpose]

    def models(self) -> dict[str, str]:
        return {p: self.model_for(p) for p in PURPOSES}


def _int(env: Mapping[str, str], name: str, default: int, *, minimum: int = 1, maximum: int | None = None) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if value < minimum or (maximum is not None and value > maximum):
        raise ConfigError(f"{name} is out of range")
    return value


def _bool(env: Mapping[str, str], name: str) -> bool:
    return env.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _pem(text: str) -> str:
    """Accepts a PEM (with real or escaped newlines) or the base64 of a PEM."""
    text = text.strip().replace("\\n", "\n")
    if "BEGIN" in text:
        return text
    try:
        return base64.b64decode(text, validate=True).decode()
    except Exception:
        raise ConfigError("AI_JWT_PUBLIC_KEY is neither a PEM nor base64 of a PEM") from None


def validate_public_key(kid: str, pem: str) -> None:
    try:
        key = load_pem_public_key(pem.encode())
    except Exception:
        raise ConfigError(f"public key '{kid}' is not a valid PEM") from None
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ConfigError(f"public key '{kid}' must be an EC P-256 key (ES256)")


def _load_keys(env: Mapping[str, str]) -> dict[str, str]:
    keys: dict[str, str] = {}
    if env.get("AI_JWT_PUBLIC_KEYS", "").strip():
        try:
            parsed = json.loads(env["AI_JWT_PUBLIC_KEYS"])
        except ValueError:
            raise ConfigError("AI_JWT_PUBLIC_KEYS must be a JSON object of kid -> PEM") from None
        if not isinstance(parsed, dict):
            raise ConfigError("AI_JWT_PUBLIC_KEYS must be a JSON object of kid -> PEM")
        keys.update({str(k): _pem(str(v)) for k, v in parsed.items()})
    single = env.get("AI_JWT_PUBLIC_KEY", "")
    path = env.get("AI_JWT_PUBLIC_KEY_FILE", "").strip()
    if path:
        try:
            single = Path(path).read_text()
        except OSError:
            raise ConfigError("AI_JWT_PUBLIC_KEY_FILE cannot be read") from None
    if single.strip():
        keys[env.get("AI_JWT_KEY_ID", "v1").strip() or "v1"] = _pem(single)
    for kid, pem in keys.items():
        validate_public_key(kid, pem)
    return keys


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    model_chat = env.get("AI_MODEL_CHAT", "").strip() or "openai/gpt-oss-120b"
    settings = Settings(
        groq_api_key=env.get("GROQ_API_KEY", "").strip(),
        groq_base_url=(env.get("GROQ_BASE_URL", "").strip() or "https://api.groq.com/openai/v1").rstrip("/"),
        model_chat=model_chat,
        model_summarize=env.get("AI_MODEL_SUMMARIZE", "").strip() or model_chat,
        request_timeout_ms=_int(env, "AI_REQUEST_TIMEOUT_MS", 90_000),
        first_byte_timeout_ms=_int(env, "AI_FIRST_BYTE_TIMEOUT_MS", 20_000),
        stream_idle_timeout_ms=_int(env, "AI_STREAM_IDLE_TIMEOUT_MS", 30_000),
        max_retries=_int(env, "AI_MAX_RETRIES", 2, minimum=0, maximum=5),
        max_output_tokens=_int(env, "AI_MAX_OUTPUT_TOKENS", 2048),
        max_body_bytes=_int(env, "AI_MAX_BODY_BYTES", 2 * 1024 * 1024),
        jwt_public_keys=_load_keys(env),
        replay_store=(env.get("AI_REPLAY_STORE", "redis").strip().lower() or "redis"),
        single_instance=_bool(env, "AI_SINGLE_INSTANCE"),
        redis_url=env.get("REDIS_URL", "").strip() or "redis://127.0.0.1:6379",
        redis_prefix=env.get("AI_REDIS_PREFIX", "").strip() or "ai-service",
        host=env.get("HOST", "").strip() or "127.0.0.1",
        port=_int(env, "PORT", 8001, maximum=65535),
        rag=_load_rag(env),
        tools=_load_tools(env),
    )
    validate_settings(settings)
    return settings


def _load_tools(env):
    from ..tools.config import load_tool_settings

    return load_tool_settings(env)


def _load_rag(env):
    from ..rag.config import load_rag_settings

    return load_rag_settings(env)


def validate_settings(settings: Settings) -> None:
    """Refuses to start in a configuration that would silently weaken a security guarantee."""
    if not settings.jwt_public_keys:
        raise ConfigError("no JWT public key configured (AI_JWT_PUBLIC_KEY / AI_JWT_PUBLIC_KEY_FILE / AI_JWT_PUBLIC_KEYS)")
    if settings.replay_store not in {"redis", "memory"}:
        raise ConfigError("AI_REPLAY_STORE must be 'redis' or 'memory'")
    if settings.replay_store == "memory" and not settings.single_instance:
        raise ConfigError(
            "AI_REPLAY_STORE=memory only protects a single process. "
            "Set AI_SINGLE_INSTANCE=true to confirm exactly one replica, or use AI_REPLAY_STORE=redis"
        )
