const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const { limitsClaim } = require('../tools/toolLimits');
const { AI_ERROR_CODES: C } = require('../../../constants/ai.constants');

/**
 * Tokens for the Node <-> Python hop. See ai/contracts/CONTRACT.md §2.
 *
 * ES256 only. Node holds the private key; Python gets the public half, so Python can verify user
 * context but never mint it. Audiences are distinct per purpose, claims are opaque ids only.
 */

const ISSUER = 'syncos-node';
const AUD = Object.freeze({
  GENERATE: 'syncos-ai:generate',
  STATUS: 'syncos-ai:status',
  CALLBACK: 'syncos-node:callback',
});
const GENERATE_TTL_SECONDS = 30; // Python allows up to 60
const STATUS_TTL_SECONDS = 30;
const CALLBACK_SCOPES = Object.freeze({ TOOL_EXECUTE: 'tool:execute', KNOWLEDGE_AUTHORIZE: 'knowledge:authorize' });

let cached = null;

function readKeyMaterial() {
  let raw = env.AI_SERVICE_SIGNING_KEY || '';
  if (env.AI_SERVICE_SIGNING_KEY_FILE) {
    try {
      raw = fs.readFileSync(env.AI_SERVICE_SIGNING_KEY_FILE, 'utf8');
    } catch {
      return null; // unreadable key file == not configured (message never includes the path contents)
    }
  }
  raw = raw.trim().replace(/\\n/g, '\n');
  if (!raw) return null;
  return raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
}

/** Loads (once) and validates the signing key. Returns null when not configured / not an EC P-256 key. */
function loadKeys() {
  const material = readKeyMaterial();
  if (!material) return null;
  if (cached && cached.material === material) return cached.keys;
  try {
    const privateKey = crypto.createPrivateKey(material);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    const keys = { privateKey, publicKey: crypto.createPublicKey(privateKey) };
    cached = { material, keys };
    return keys;
  } catch {
    return null;
  }
}

const isSigningConfigured = () => loadKeys() !== null;

function requireKeys() {
  const keys = loadKeys();
  if (!keys) throw new AppError('The AI service credentials are not configured', 503, C.NOT_CONFIGURED);
  return keys;
}

function sign({ jti, ...claims }, audience, ttlSeconds) {
  const { privateKey } = requireKeys();
  return jwt.sign(claims, privateKey, {
    algorithm: 'ES256',
    keyid: env.AI_SERVICE_KEY_ID,
    issuer: ISSUER,
    audience,
    expiresIn: ttlSeconds,
    notBefore: 0,
    jwtid: jti,
  });
}

const newId = () => crypto.randomUUID();

/**
 * `spaceId` (retrieval only) is the embedding space Node says is ACTIVE; Python refuses to search with a model from another space.
 * `liveTools` (claim `lt: true`) says: Node opened a tool budget for THIS request, so Python may orchestrate live-data tools.
 * `tl` carries Node's tool limits with it (Python may only tighten them). It is only ever true here; the claims are absent otherwise. It is a claim of the signed token, never a request-body field.
 */
function signGenerateToken({ userId, orgId, requestKey, maxOutputTokens, spaceId, liveTools = false }) {
  return sign({ jti: requestKey, sub: String(userId), org: String(orgId), mo: maxOutputTokens, ...(spaceId ? { spc: String(spaceId) } : {}), ...(liveTools === true ? { lt: true, tl: limitsClaim() } : {}) }, AUD.GENERATE, GENERATE_TTL_SECONDS);
}

function signStatusToken() {
  return sign({ jti: newId() }, AUD.STATUS, STATUS_TTL_SECONDS);
}

/** Carried by Python and presented back to Node's internal listener. Dead once the request leaves the in-flight set. */
function signCallbackToken({ userId, orgId, requestKey, scopes = [CALLBACK_SCOPES.TOOL_EXECUTE] }) {
  const ttl = Math.ceil(env.AI_REQUEST_CEILING_MS / 1000) + 30;
  return sign({ jti: newId(), sub: String(userId), org: String(orgId), rid: requestKey, scp: scopes }, AUD.CALLBACK, ttl);
}

/** Strict verification of a callback token. Throws a generic 401 on ANY problem. */
function verifyCallbackToken(token) {
  const reject = () => new AppError('Unauthorized', 401, 'AI_CALLBACK_UNAUTHORIZED');
  const keys = loadKeys();
  if (!keys || typeof token !== 'string' || token.length > 4096) throw reject();
  let claims;
  try {
    claims = jwt.verify(token, keys.publicKey, { algorithms: ['ES256'], audience: AUD.CALLBACK, issuer: ISSUER, clockTolerance: 5 });
  } catch {
    throw reject();
  }
  const id = /^[A-Za-z0-9_-]{8,128}$/;
  const lifetime = claims.exp - claims.iat;
  const valid =
    typeof claims.sub === 'string' && id.test(claims.sub) &&
    typeof claims.org === 'string' && id.test(claims.org) &&
    typeof claims.rid === 'string' && id.test(claims.rid) &&
    Array.isArray(claims.scp) && claims.scp.every((s) => typeof s === 'string') &&
    lifetime > 0 && lifetime <= Math.ceil(env.AI_REQUEST_CEILING_MS / 1000) + 60;
  if (!valid) throw reject();
  return { userId: claims.sub, orgId: claims.org, requestKey: claims.rid, scopes: claims.scp };
}

module.exports = { AUD, CALLBACK_SCOPES, ISSUER, isSigningConfigured, signCallbackToken, signGenerateToken, signStatusToken, verifyCallbackToken };
