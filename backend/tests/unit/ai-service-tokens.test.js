const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const tokens = require('../../src/services/ai/aiService/tokens');
const { createKeyPair } = require('../helpers/stubAiService');

const pair = createKeyPair();
const other = createKeyPair();
const IDS = { userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: crypto.randomUUID() };

beforeEach(() => {
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_SERVICE_SIGNING_KEY_FILE = '';
  env.AI_SERVICE_KEY_ID = 'v1';
});

const decode = (t) => jwt.decode(t, { complete: true });

describe('generate / status tokens', () => {
  test('generate token is ES256 with kid, minimal claims and a short life', () => {
    const { header, payload } = decode(tokens.signGenerateToken({ ...IDS, maxOutputTokens: 256 }));
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: 'v1' });
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'mo', 'nbf', 'org', 'sub']);
    expect(payload).toMatchObject({ iss: 'syncos-node', aud: 'syncos-ai:generate', sub: IDS.userId, org: IDS.orgId, jti: IDS.requestKey, mo: 256 });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(60);
  });

  test('verifies with the public key only, and not with anyone else\'s', () => {
    const t = tokens.signGenerateToken({ ...IDS, maxOutputTokens: 1 });
    expect(() => jwt.verify(t, pair.publicKey, { algorithms: ['ES256'], audience: 'syncos-ai:generate' })).not.toThrow();
    expect(() => jwt.verify(t, other.publicKey, { algorithms: ['ES256'], audience: 'syncos-ai:generate' })).toThrow();
    expect(() => jwt.verify(t, pair.publicKey, { algorithms: ['ES256'], audience: 'syncos-ai:status' })).toThrow();
  });

  test('status token carries no identity', () => {
    const { payload } = decode(tokens.signStatusToken());
    expect(payload).toMatchObject({ aud: 'syncos-ai:status' });
    expect(payload.sub).toBeUndefined();
    expect(payload.org).toBeUndefined();
  });

  test('the token never contains role, permissions, email or names', () => {
    const { payload } = decode(tokens.signGenerateToken({ ...IDS, maxOutputTokens: 5 }));
    for (const key of ['role', 'permissions', 'email', 'name', 'scp']) expect(payload).not.toHaveProperty(key);
  });

  test('refuses to sign without a valid EC P-256 key', () => {
    env.AI_SERVICE_SIGNING_KEY = '';
    expect(tokens.isSigningConfigured()).toBe(false);
    expect(() => tokens.signGenerateToken({ ...IDS, maxOutputTokens: 1 })).toThrow(expect.objectContaining({ code: 'AI_NOT_CONFIGURED' }));
    env.AI_SERVICE_SIGNING_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(tokens.isSigningConfigured()).toBe(false); // RSA is not accepted: ES256 only
    env.AI_SERVICE_SIGNING_KEY = 'not a key';
    expect(tokens.isSigningConfigured()).toBe(false);
  });

  test('accepts the key as base64 of a PEM', () => {
    env.AI_SERVICE_SIGNING_KEY = Buffer.from(pair.privateKey).toString('base64');
    expect(tokens.isSigningConfigured()).toBe(true);
  });
});

describe('callback tokens', () => {
  const mint = (over = {}) => tokens.signCallbackToken({ ...IDS, ...over });

  test('round-trips ids and scopes', () => {
    expect(tokens.verifyCallbackToken(mint())).toEqual({ userId: IDS.userId, orgId: IDS.orgId, requestKey: IDS.requestKey, scopes: ['tool:execute'] });
  });

  test('has its own audience: generate and status tokens are rejected', () => {
    for (const t of [tokens.signGenerateToken({ ...IDS, maxOutputTokens: 1 }), tokens.signStatusToken()]) {
      expect(() => tokens.verifyCallbackToken(t)).toThrow(expect.objectContaining({ statusCode: 401 }));
    }
  });

  test('rejects wrong alg, foreign signer, tampering, expiry and garbage with one generic 401', () => {
    const forge = (payload, key, alg) => jwt.sign(payload, key, { algorithm: alg, keyid: 'v1', audience: tokens.AUD.CALLBACK, issuer: tokens.ISSUER, expiresIn: 60 });
    const good = { sub: IDS.userId, org: IDS.orgId, rid: IDS.requestKey, scp: ['tool:execute'], jti: crypto.randomUUID() };
    const bad = [
      forge(good, 'a-shared-secret-that-is-long-enough', 'HS256'),
      forge(good, other.privateKey, 'ES256'),
      jwt.sign(good, null, { algorithm: 'none', audience: tokens.AUD.CALLBACK, issuer: tokens.ISSUER }),
      `${mint().slice(0, -4)}AAAA`,
      '',
      'x.y.z',
      'a'.repeat(5000),
      forge({ ...good, rid: undefined }, pair.privateKey, 'ES256'),
      forge({ ...good, scp: 'tool:execute' }, pair.privateKey, 'ES256'),
      forge({ ...good, sub: '../../etc' }, pair.privateKey, 'ES256'),
    ];
    for (const t of bad) {
      expect(() => tokens.verifyCallbackToken(t)).toThrow(expect.objectContaining({ statusCode: 401, code: 'AI_CALLBACK_UNAUTHORIZED' }));
    }
    const expired = jwt.sign(good, pair.privateKey, { algorithm: 'ES256', audience: tokens.AUD.CALLBACK, issuer: tokens.ISSUER, expiresIn: -60 });
    expect(() => tokens.verifyCallbackToken(expired)).toThrow(expect.objectContaining({ statusCode: 401 }));
  });

  test('a callback token lives no longer than the request ceiling (plus slack)', () => {
    const { payload } = decode(mint());
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(Math.ceil(env.AI_REQUEST_CEILING_MS / 1000) + 60);
  });
});
