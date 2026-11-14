import json
import time
import uuid
from pathlib import Path

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.core.config import Settings
from app.core.replay import MemoryReplayGuard
from app.main import create_app
from app.providers.groq import GroqProvider

CONTRACTS = Path(__file__).resolve().parents[1] / "contracts"


def load_contract(name):
    return json.loads((CONTRACTS / name).read_text())


def _pair():
    private = ec.generate_private_key(ec.SECP256R1())
    priv_pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    pub_pem = private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return priv_pem, pub_pem


@pytest.fixture(scope="session")
def keys():
    return {"v1": _pair(), "other": _pair()}


@pytest.fixture
def public_keys(keys):
    return {"v1": keys["v1"][1]}


def sign(private_pem, *, aud="syncos-ai:generate", kid="v1", alg="ES256", lifetime=30, **claims):
    now = int(time.time())
    payload = {"iss": "syncos-node", "aud": aud, "iat": now, "nbf": now, "exp": now + lifetime, "jti": uuid.uuid4().hex}
    if aud == "syncos-ai:generate":
        payload.update({"sub": "u" * 24, "org": "o" * 24, "mo": 512})
    payload.update(claims)
    payload = {k: v for k, v in payload.items() if v is not None}
    return jwt.encode(payload, private_pem, algorithm=alg, headers={"kid": kid} if kid else {})


@pytest.fixture
def token(keys):
    return lambda **kw: sign(keys["v1"][0], **kw)


def make_settings(public_keys, **over):
    base = dict(
        groq_api_key="gsk_TEST_KEY_NOT_REAL",
        groq_base_url="https://groq.test/openai/v1",
        jwt_public_keys=public_keys,
        replay_store="memory",
        single_instance=True,
        backoff_base_ms=1,
        backoff_max_ms=2,
        first_byte_timeout_ms=500,
        stream_idle_timeout_ms=500,
        request_timeout_ms=3000,
    )
    base.update(over)
    return Settings(**base)


@pytest.fixture
def settings(public_keys):
    return make_settings(public_keys)


def sse(*chunks, done=True):
    """Builds a Groq-style SSE body from dicts (or raw strings)."""
    out = ""
    for c in chunks:
        out += f"data: {c if isinstance(c, str) else json.dumps(c)}\n\n"
    if done:
        out += "data: [DONE]\n\n"
    return out


def delta(text=None, *, finish=None, tool_calls=None, usage=None, model="openai/gpt-oss-120b", id="chatcmpl-1", reasoning=None):
    d = {}
    if text is not None:
        d["content"] = text
    if tool_calls is not None:
        d["tool_calls"] = tool_calls
    if reasoning is not None:
        d["reasoning"] = reasoning
    chunk = {"id": id, "model": model, "choices": [{"index": 0, "delta": d, "finish_reason": finish}]}
    if usage:
        chunk["usage"] = usage
    return chunk


class Upstream:
    """Scriptable fake of Groq behind httpx.MockTransport. Records every request it receives."""

    def __init__(self):
        self.requests = []
        self.plans = []
        self.closed = 0
        self.default = (200, sse(delta("hi"), delta(finish="stop", usage={"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7})), {})

    def enqueue(self, status=200, body="", headers=None, stream=None):
        self.plans.append((status, body, headers or {}, stream))
        return self

    async def handler(self, request: httpx.Request):
        self.requests.append(request)
        status, body, headers, stream = self.plans.pop(0) if self.plans else (*self.default, None)
        if stream is not None:
            return httpx.Response(status, headers={"content-type": "text/event-stream", **headers}, stream=_Closing(stream(), self))
        content = body if isinstance(body, bytes) else (json.dumps(body) if isinstance(body, (dict, list)) else body)
        ctype = "text/event-stream" if status == 200 else "application/json"
        return httpx.Response(status, headers={"content-type": ctype, **headers}, stream=_Closing(_once(content.encode() if isinstance(content, str) else content), self))

    def body(self, index=-1):
        return json.loads(self.requests[index].content)

    def client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


class _Closing(httpx.AsyncByteStream):
    def __init__(self, gen, upstream):
        self._gen, self._up = gen, upstream

    async def __aiter__(self):
        async for chunk in self._gen:
            yield chunk

    async def aclose(self):
        self._up.closed += 1
        await self._gen.aclose()


async def _once(content):
    yield content


@pytest.fixture
def upstream():
    return Upstream()


@pytest.fixture
def provider(settings, upstream):
    return GroqProvider(settings, http=upstream.client(), sleep=_no_sleep)


async def _no_sleep(_):
    return None


@pytest.fixture
def app(settings, upstream):
    return create_app(settings, provider=GroqProvider(settings, http=upstream.client(), sleep=_no_sleep), replay=MemoryReplayGuard())


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai.test") as c:
        yield c


@pytest.fixture(scope="session")
def tokenizer_path():
    """The REAL embedding tokenizer from the Hugging Face cache (offline). Tests that need it skip - loudly - without it."""
    from app.embeddings.fastembed_provider import EmbeddingConfig, snapshot_dir
    from app.embeddings.provider import ModelUnavailable
    from app.embeddings.spec import E5_SMALL

    try:
        return str(snapshot_dir(E5_SMALL, EmbeddingConfig(offline=True)) / "tokenizer.json")
    except ModelUnavailable:
        pytest.skip("multilingual-e5-small tokenizer not in the Hugging Face cache (run scripts/benchmark_embeddings.py once)")


# ---- a REAL Qdrant server (the release binary downloaded into ai/.qdrant, gitignored) --------------------------------

QDRANT_BIN = Path(__file__).resolve().parents[1] / ".qdrant" / "qdrant"
QDRANT_TEST_KEY = "test-api-key-not-a-secret"


def _free_port():
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def qdrant_server(tmp_path_factory):
    """Starts the real server on loopback with API-key auth. Skips (visibly) if the binary is not there."""
    import os
    import subprocess
    import time as _time

    if not QDRANT_BIN.exists():
        pytest.skip("Qdrant binary not found in ai/.qdrant (see ai/README.md)")
    root = tmp_path_factory.mktemp("qdrant-server")
    http, grpc = _free_port(), _free_port()
    env = {
        "PATH": os.environ["PATH"],
        "QDRANT__SERVICE__HOST": "127.0.0.1",
        "QDRANT__SERVICE__HTTP_PORT": str(http),
        "QDRANT__SERVICE__GRPC_PORT": str(grpc),
        "QDRANT__SERVICE__API_KEY": QDRANT_TEST_KEY,
        "QDRANT__STORAGE__STORAGE_PATH": str(root / "storage"),
        "QDRANT__STORAGE__SNAPSHOTS_PATH": str(root / "snapshots"),
        "QDRANT__TELEMETRY_DISABLED": "true",
    }
    proc = subprocess.Popen([str(QDRANT_BIN)], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{http}"
    deadline = _time.time() + 30
    while _time.time() < deadline:
        try:
            if httpx.get(f"{url}/healthz", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            _time.sleep(0.2)
    else:
        proc.kill()
        pytest.fail("the Qdrant server did not start")
    yield {"url": url, "api_key": QDRANT_TEST_KEY, "port": http}
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
