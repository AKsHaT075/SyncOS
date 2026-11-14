"""Short-lived ES256 tokens the worker presents to Node's internal ingestion endpoints.

This is the OPPOSITE direction from the generate token: here Python signs and Node verifies, with a separate key
pair and audience, so neither key can be used for the other direction.
"""
from __future__ import annotations

import time
import uuid

import jwt

ISSUER = "syncos-ai-worker"
AUDIENCE = "syncos-node:ingestion"
EMBEDDING_AUDIENCE = "syncos-node:embedding"  # same worker key pair, strictly separate purpose
LIFETIME_SECONDS = 30


def sign_worker_token(private_pem: str, key_id: str, worker_id: str, audience: str = AUDIENCE) -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": ISSUER, "aud": audience, "sub": worker_id, "iat": now, "nbf": now, "exp": now + LIFETIME_SECONDS, "jti": uuid.uuid4().hex},
        private_pem,
        algorithm="ES256",
        headers={"kid": key_id},
    )
