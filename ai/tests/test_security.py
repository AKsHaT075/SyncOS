import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization

from app.core import security
from app.core.config import ConfigError, Settings, load_settings, validate_settings
from tests.conftest import sign


def check(token, keys, aud=security.AUD_GENERATE):
    return security.verify(token, audience=aud, keys=keys)


def reason(token, keys, aud=security.AUD_GENERATE):
    with pytest.raises(security.TokenError) as e:
        check(token, keys, aud)
    return e.value.reason


def test_valid_generate_token(token, public_keys):
    claims = check(token(), public_keys)
    assert claims.sub == "u" * 24 and claims.org == "o" * 24 and claims.max_output_tokens == 512


def test_valid_status_token(token, public_keys):
    assert check(token(aud=security.AUD_STATUS), public_keys, security.AUD_STATUS).sub is None


def test_a_token_for_one_purpose_is_useless_for_another(token, public_keys):
    assert reason(token(aud=security.AUD_STATUS), public_keys, security.AUD_GENERATE) == "InvalidAudienceError"
    assert reason(token(), public_keys, security.AUD_STATUS) == "InvalidAudienceError"
    assert reason(token(aud="syncos-node:callback"), public_keys) == "InvalidAudienceError"


def test_rejects_alg_none(public_keys):
    now = int(time.time())
    forged = jwt.encode({"iss": "syncos-node", "aud": security.AUD_GENERATE, "iat": now, "nbf": now, "exp": now + 30, "jti": "a" * 16, "sub": "u" * 24, "org": "o" * 24, "mo": 10}, key=None, algorithm="none", headers={"kid": "v1"})
    assert reason(forged, public_keys) == "alg"


def test_rejects_hs256_signed_with_the_public_key(public_keys):
    # Classic algorithm-confusion attack: the attacker only knows the public key.
    now = int(time.time())
    pub = public_keys["v1"]
    claims = {"iss": "syncos-node", "aud": security.AUD_GENERATE, "iat": now, "nbf": now, "exp": now + 30, "jti": "a" * 16, "sub": "u" * 24, "org": "o" * 24, "mo": 10}
    import hmac, hashlib, base64, json
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": "v1"}).encode())
    body = b64(json.dumps(claims).encode())
    sig = b64(hmac.new(pub.encode(), head + b"." + body, hashlib.sha256).digest())
    assert reason((head + b"." + body + b"." + sig).decode(), public_keys) == "alg"


def test_rejects_rs256(public_keys):
    from cryptography.hazmat.primitives.asymmetric import rsa

    rsa_key = rsa.generate_private_key(65537, 2048)
    pem = rsa_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    assert reason(sign(pem, alg="RS256"), public_keys) == "alg"


def test_rejects_unknown_or_missing_kid(token, public_keys):
    assert reason(token(kid="v9"), public_keys) == "kid"
    assert reason(token(kid=None), public_keys) == "kid"


def test_rejects_a_token_signed_by_someone_else(keys, public_keys):
    assert reason(sign(keys["other"][0]), public_keys) == "InvalidSignatureError"


def test_rejects_tampered_payload(token, public_keys):
    head, body, sig = token().split(".")
    import base64, json
    payload = json.loads(base64.urlsafe_b64decode(body + "=="))
    payload["org"] = "x" * 24
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    assert reason(f"{head}.{forged}.{sig}", public_keys) == "InvalidSignatureError"


def test_rejects_expired(token, public_keys):
    now = int(time.time())
    assert reason(token(iat=now - 100, nbf=now - 100, exp=now - 50), public_keys) == "ExpiredSignatureError"


def test_rejects_long_lived_tokens(token, public_keys):
    assert reason(token(lifetime=3600), public_keys) == "lifetime"


@pytest.mark.parametrize("missing", ["jti", "exp", "iat", "nbf", "iss"])
def test_rejects_missing_required_claims(token, public_keys, missing):
    assert reason(token(**{missing: None}), public_keys) == "MissingRequiredClaimError"


def test_rejects_wrong_issuer(token, public_keys):
    assert reason(token(iss="evil"), public_keys) == "InvalidIssuerError"


@pytest.mark.parametrize("claims", [{"sub": None}, {"org": None}, {"sub": "../etc"}, {"org": "a b"}, {"mo": None}, {"mo": 0}, {"mo": 10**9}, {"mo": True}, {"mo": "10"}])
def test_rejects_bad_identity_or_budget(token, public_keys, claims):
    assert reason(token(**claims), public_keys) in {"identity", "mo"}


def test_rejects_garbage(public_keys):
    assert reason("", public_keys) == "malformed"
    assert reason("not.a.jwt", public_keys) == "malformed"
    assert reason("a" * 5000, public_keys) == "malformed"


def test_token_carries_no_extra_identity(token):
    payload = jwt.decode(token(), options={"verify_signature": False})
    assert set(payload) <= {"iss", "aud", "iat", "nbf", "exp", "jti", "sub", "org", "mo"}


# ---- configuration safety -------------------------------------------------------------------

def test_config_refuses_memory_replay_without_single_instance_ack(public_keys):
    with pytest.raises(ConfigError, match="AI_SINGLE_INSTANCE"):
        validate_settings(Settings(jwt_public_keys=public_keys, replay_store="memory", single_instance=False))
    validate_settings(Settings(jwt_public_keys=public_keys, replay_store="memory", single_instance=True))
    validate_settings(Settings(jwt_public_keys=public_keys, replay_store="redis"))


def test_config_requires_a_key(public_keys):
    with pytest.raises(ConfigError):
        validate_settings(Settings(jwt_public_keys={}))


def test_config_rejects_non_p256_keys():
    from cryptography.hazmat.primitives.asymmetric import ec, rsa

    rsa_pub = rsa.generate_private_key(65537, 2048).public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    with pytest.raises(ConfigError, match="P-256"):
        load_settings({"AI_JWT_PUBLIC_KEY": rsa_pub, "REDIS_URL": "redis://x"})
    p384 = ec.generate_private_key(ec.SECP384R1()).public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    with pytest.raises(ConfigError, match="P-256"):
        load_settings({"AI_JWT_PUBLIC_KEY": p384})


def test_config_error_messages_never_contain_the_key(public_keys):
    with pytest.raises(ConfigError) as e:
        load_settings({"AI_JWT_PUBLIC_KEY": "-----BEGIN PUBLIC KEY-----\nSECRETISH\n-----END PUBLIC KEY-----"})
    assert "SECRETISH" not in str(e.value)


def test_load_settings_accepts_base64_pem(public_keys):
    import base64

    s = load_settings({"AI_JWT_PUBLIC_KEY": base64.b64encode(public_keys["v1"].encode()).decode(), "GROQ_API_KEY": "k", "AI_REPLAY_STORE": "redis"})
    assert "v1" in s.jwt_public_keys and s.configured
