const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const { createRedisClient } = require('../../../config/redis');

/**
 * Authenticates the Python ingestion worker on Node's internal listener.
 *
 * Direction is the OPPOSITE of the generate token: the worker signs (ES256), Node verifies with the worker's
 * PUBLIC key (AI_WORKER_PUBLIC_KEY). Tokens are 30 s, audience `syncos-node:ingestion`, and single use: the jti is
 * consumed atomically in Redis (SET NX EX), and an unreachable Redis refuses the call (fail closed). The token proves
 * "this is our worker"; it grants NOTHING by itself - every route still ties access to a claimed job + lock token.
 */

const ISSUER = 'syncos-ai-worker';
const AUDIENCE = 'syncos-node:ingestion';
const EMBEDDING_AUDIENCE = 'syncos-node:embedding'; // same worker key pair, but a token minted for one purpose is useless for the other
const MAX_LIFETIME_SECONDS = 60;
const ID = /^[A-Za-z0-9_-]{8,128}$/;
let cached = null;

function publicKey() {
  let raw = env.AI_WORKER_PUBLIC_KEY || '';
  if (env.AI_WORKER_PUBLIC_KEY_FILE) {
    try {
      raw = fs.readFileSync(env.AI_WORKER_PUBLIC_KEY_FILE, 'utf8');
    } catch {
      return null;
    }
  }
  raw = raw.trim().replace(/\\n/g, '\n');
  if (!raw) return null;
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  if (cached && cached.pem === pem) return cached.key;
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    cached = { pem, key };
    return key;
  } catch {
    return null;
  }
}

const isWorkerAuthConfigured = () => publicKey() !== null;
const unauthorized = () => new AppError('Unauthorized', 401, 'INGESTION_UNAUTHORIZED');

async function consumeJti(jti) {
  const client = createRedisClient();
  if (!client.isOpen) throw new AppError('Ingestion is temporarily unavailable', 503, 'INGESTION_UNAVAILABLE');
  try {
    const first = await client.set(`${env.AI_REDIS_PREFIX}:ingest:jti:${jti}`, '1', { NX: true, EX: 120 });
    return first === 'OK';
  } catch {
    throw new AppError('Ingestion is temporarily unavailable', 503, 'INGESTION_UNAVAILABLE');
  }
}

/** Verifies the bearer token and consumes its jti. Returns { workerId }. */
async function authenticateWorker(authorizationHeader, audience = AUDIENCE) {
  const key = publicKey();
  if (!key) throw new AppError('Document ingestion is not configured', 503, 'INGESTION_NOT_CONFIGURED');
  const [scheme, token] = String(authorizationHeader || '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 4096) throw unauthorized();

  let claims;
  try {
    const header = jwt.decode(token, { complete: true })?.header;
    if (header?.alg !== 'ES256' || header.kid !== env.AI_WORKER_KEY_ID) throw new Error('header');
    claims = jwt.verify(token, key, { algorithms: ['ES256'], audience, issuer: ISSUER, clockTolerance: 5 });
  } catch {
    throw unauthorized();
  }
  const lifetime = claims.exp - claims.iat;
  if (!(lifetime > 0 && lifetime <= MAX_LIFETIME_SECONDS) || typeof claims.nbf !== 'number' || typeof claims.sub !== 'string' || claims.sub.length > 80 || !ID.test(claims.jti || '')) {
    throw unauthorized();
  }
  if (!(await consumeJti(claims.jti))) throw unauthorized(); // replay
  return { workerId: claims.sub };
}

module.exports = { AUDIENCE, EMBEDDING_AUDIENCE, ISSUER, authenticateWorker, isWorkerAuthConfigured };
