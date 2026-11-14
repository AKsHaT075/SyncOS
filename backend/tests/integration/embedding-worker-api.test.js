jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/**
 * The embedding worker's view of Node (internal listener) and the administrators' views (tenant + platform).
 * Focus: authentication and audience separation, job/lock binding, tenant isolation, live re-checks, result
 * validation, migration authority, and that no document text ever reaches logs or admin responses.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createIndexedDocument, createStoredDocument, createWorkerKeys, ensureIndexes, signWorkerToken } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AuditLog = require('../../src/models/AuditLog');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const EmbeddingJob = require('../../src/models/EmbeddingJob');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const jobs = require('../../src/services/ai/embedding/embeddingJobs.service');
const spaces = require('../../src/services/ai/embedding/embeddingSpaces.service');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser, makeAgent, as } = createHarness();
const internal = createInternalApp();
const keys = createWorkerKeys();
const foreign = createWorkerKeys();
const oid = () => new mongoose.Types.ObjectId();
const FAKE = describeSpace('fake-hash-384');
const E5 = describeSpace('multilingual-e5-small');
const AUD = 'syncos-node:embedding';
const KEYS = ['ownerA', 'adminA', 'hrA', 'managerA', 'guestA', 'adminB', 'superadmin'];
const SECRET = 'BOARD-CONFIDENTIAL layoffs planned for Q3';
const saved = {};
let orgA; let orgB;

const tok = (over = {}) => signWorkerToken(keys.privatePem, { aud: AUD, ...over });
const call = (method, path, { token = tok(), body, lock, query } = {}) => {
  let req = request(internal)[method](`/internal/embedding${path}`);
  if (query) req = req.query(query);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (lock) req = req.set('X-Lock-Token', lock);
  return body === undefined ? req : req.send(body);
};
const redis = () => createRedisClient();
/**
 * An unauthenticated caller is refused WITHOUT the server reading its body. Depending on timing the client then sees either
 * the 401 or a reset connection while it is still writing: both mean "refused", anything else is a failure.
 */
const refusedWithoutReading = async (req) => {
  try {
    const res = await req;
    return res.status === 401 ? 'refused' : `status ${res.status}`;
  } catch (error) {
    return ['ECONNRESET', 'EPIPE'].includes(error.code) ? 'refused' : `error ${error.code}`;
  }
};
const indexed = (over = {}) => createIndexedDocument({ organization: orgA, owner: users.ownerA, ...over });
const enqueue = (doc, over = {}) => jobs.enqueueEmbed({ organization: doc.organization, document: doc._id, version: doc.currentVersion, spaceId: FAKE.id, ...over });
const digest = async (doc, version = 1) => spaces.digestOf((await DocumentChunk.find({ document: doc._id, version }).sort({ chunkIndex: 1 }).lean()).map((c) => c.textHash));

async function claimed(over = {}) {
  const made = over.doc ? { doc: over.doc } : await indexed({ chunks: over.chunks || 3, ...(over.docOver || {}) });
  await enqueue(made.doc);
  const res = await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } }).expect(200);
  return { doc: made.doc, job: res.body.job };
}
async function okResult(doc, over = {}) {
  return { status: 'embedded', spaceId: FAKE.id, model: FAKE.descriptor.model, revision: FAKE.descriptor.revision, dimensions: 384, count: await DocumentChunk.countDocuments({ document: doc._id, version: 1 }), digest: await digest(doc), ...over };
}
const submit = (job, result, lock = job.lockToken) => call('post', `/jobs/${job.id}/result`, { body: { lockToken: lock, result } });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(KEYS.map(makeAgent));
  for (const k of ['AI_WORKER_PUBLIC_KEY', 'AI_WORKER_PUBLIC_KEY_FILE', 'AI_WORKER_KEY_ID', 'AI_EMBEDDING_SPACE', 'AI_EMBEDDING_MAX_ATTEMPTS', 'AI_EMBEDDING_LEASE_SECONDS']) saved[k] = env[k];
});
afterAll(async () => {
  Object.assign(env, saved);
  await hub.shutdown();
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  Object.assign(env, saved);
  env.AI_WORKER_PUBLIC_KEY = keys.publicPem;
  env.AI_WORKER_PUBLIC_KEY_FILE = '';
  env.AI_WORKER_KEY_ID = 'w1';
  env.AI_EMBEDDING_SPACE = 'fake-hash-384';
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, AuditLog, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'ownerA', ROLES.EMPLOYEE);
  await createUser(orgA, 'adminA', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hrA', ROLES.HR);
  await createUser(orgA, 'managerA', ROLES.MANAGER);
  await createUser(orgA, 'guestA', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
});

describe('authentication: same worker key pair, strictly separate audience', () => {
  test.each([
    ['no token', { token: null }],
    ['garbage', { token: 'not.a.jwt' }],
    ['signed by a different key', { token: signWorkerToken(foreign.privatePem, { aud: AUD }) }],
    ['an INGESTION token (wrong audience)', { token: signWorkerToken(keys.privatePem, { aud: 'syncos-node:ingestion' }) }],
    ['a generate token audience', { token: tok({ aud: 'syncos-ai:generate' }) }],
    ['wrong issuer', { token: tok({ iss: 'syncos-node' }) }],
    ['unknown key id', { token: tok({ kid: 'w9' }) }],
    ['expired', { token: tok({ lifetime: -120 }) }],
    ['lifetime too long', { token: tok({ lifetime: 3600 }) }],
    ['HS256 signed with the public key', { token: tok({ alg: 'HS256', key: keys.publicPem }) }],
    ['no jti', { token: tok({ claims: { jti: undefined } }) }],
  ])('%s => 401 and nothing is claimed', async (_n, opts) => {
    const { doc } = await indexed();
    await enqueue(doc);
    const res = await call('post', '/claim', { ...opts, body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } });
    expect(res.status).toBe(401);
    expect(await EmbeddingJob.countDocuments({ status: 'processing' })).toBe(0);
  });

  test('an embedding token is useless on the ingestion routes, and an ingestion token on the embedding routes', async () => {
    const asEmbedding = await request(internal).post('/internal/ingestion/claim').set('Authorization', `Bearer ${tok()}`).send({ pipelineVersion: 'p2' });
    expect(asEmbedding.status).toBe(401);
    const asIngestion = await call('post', '/claim', { token: signWorkerToken(keys.privatePem, { aud: 'syncos-node:ingestion' }), body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } });
    expect(asIngestion.status).toBe(401);
  });

  test('tokens are single use, even under a concurrent replay', async () => {
    const t = tok();
    await call('post', '/claim', { token: t, body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } }).expect(200);
    expect((await call('post', '/claim', { token: t, body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).status).toBe(401);
    const t2 = tok();
    const results = await Promise.all(Array.from({ length: 12 }, () => call('post', '/claim', { token: t2, body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test('fails closed: no worker key => 503, Redis unable to prove single use => 503', async () => {
    env.AI_WORKER_PUBLIC_KEY = '';
    expect((await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).status).toBe(503);
    env.AI_WORKER_PUBLIC_KEY = keys.publicPem;
    jest.spyOn(redis(), 'set').mockRejectedValue(new Error('redis down'));
    expect((await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).status).toBe(503);
  });

  test('authentication precedes body parsing: an unauthenticated caller cannot make Node buffer a payload', async () => {
    const status = await refusedWithoutReading(request(internal).post('/internal/embedding/jobs/abc/result').set('Content-Type', 'application/json').send(JSON.stringify({ lockToken: 'x'.repeat(32), result: { pad: 'x'.repeat(200000) } })));
    expect(status).toBe('refused');
  });
});

describe('claim', () => {
  test('returns what the worker needs (including the tenant for its vector-store filters) and records the AUTHENTICATED worker id', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const res = await call('post', '/claim', { token: tok({ claims: { sub: 'embedder-7' } }), body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } }).expect(200);
    expect(res.body.job).toEqual({
      id: expect.any(String), kind: 'embed', organization: orgA._id.toString(), document: doc._id.toString(), version: 1, ingestionPipeline: 'p2', spaceId: FAKE.id,
      keepVersion: null, generation: 0, chunkCount: 3, lockToken: expect.any(String), leaseSeconds: env.AI_EMBEDDING_LEASE_SECONDS, attempt: 1,
    });
    expect((await EmbeddingJob.findById(res.body.job.id)).lockedBy).toBe('embedder-7');
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(doc.name)); // no document names
  });

  test('strict body, only served spaces, nothing when idle', async () => {
    expect((await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } }).expect(200)).body.job).toBeNull();
    for (const bad of [{ spaceId: 'nothex', ingestionPipeline: 'p2' }, { spaceId: FAKE.id }, { spaceId: FAKE.id, ingestionPipeline: 'p2', organization: String(orgB._id) }, {}]) {
      expect((await call('post', '/claim', { body: bad })).status).toBe(400);
    }
    const { doc } = await indexed();
    await enqueue(doc, { spaceId: E5.id }); // a space nobody serves
    expect((await call('post', '/claim', { body: { spaceId: E5.id, ingestionPipeline: 'p2' } }).expect(200)).body.job).toBeNull();
  });

  test('two workers never receive the same job', async () => {
    for (let i = 0; i < 5; i += 1) await enqueue((await indexed()).doc);
    const res = await Promise.all(Array.from({ length: 16 }, () => call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })));
    const got = res.map((r) => r.body.job).filter(Boolean);
    expect(got).toHaveLength(5);
    expect(new Set(got.map((j) => j.id)).size).toBe(5);
  });

  test('a purge job carries its scope and generation', async () => {
    const { doc } = await indexed();
    await jobs.enqueuePurge({ organization: orgA._id, document: doc._id, spaceId: FAKE.id, keepVersion: 2 });
    const job = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } }).expect(200)).body.job;
    expect(job).toMatchObject({ kind: 'purge', organization: orgA._id.toString(), document: doc._id.toString(), keepVersion: 2, generation: 1, spaceId: FAKE.id });
  });
});

describe('chunk text: only the claimed job\'s tenant data, only while it is still valid', () => {
  test('pages through exactly the document version\'s chunks', async () => {
    const { doc, job } = await claimed({ chunks: 7 });
    const seen = [];
    let after = -1;
    for (let guard = 0; guard < 10; guard += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken, query: { after, limit: 3 } }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      seen.push(...res.body.chunks);
      if (res.body.next === null) break;
      after = res.body.next;
    }
    const stored = await DocumentChunk.find({ document: doc._id }).sort({ chunkIndex: 1 }).lean();
    expect(seen.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen.map((c) => [c.textHash, c.text])).toEqual(stored.map((c) => [c.textHash, c.text]));
  });

  test('the wrong, missing, or someone else\'s lock token gets nothing', async () => {
    const a = await claimed();
    const b = await claimed();
    for (const lock of [b.job.lockToken, undefined, 'x'.repeat(48)]) {
      expect((await call('get', `/jobs/${a.job.id}/chunks`, { lock })).status).toBe(409);
    }
    expect((await call('get', `/jobs/not-an-id/chunks`, { lock: a.job.lockToken })).status).toBe(409);
    expect((await call('get', `/jobs/${oid()}/chunks`, { lock: a.job.lockToken })).status).toBe(409);
  });

  test('a queued (unclaimed) job and an expired lease cannot read', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const queued = await EmbeddingJob.findOne({ document: doc._id });
    expect((await call('get', `/jobs/${queued._id}/chunks`, { lock: 'a'.repeat(48) })).status).toBe(409);
    const { job } = await claimed();
    await EmbeddingJob.updateOne({ _id: job.id }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken })).status).toBe(409);
  });

  test('a purge job can never read chunks', async () => {
    const { doc } = await indexed();
    await jobs.enqueuePurge({ organization: orgA._id, document: doc._id, spaceId: FAKE.id });
    const job = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    expect((await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken })).status).toBe(409);
  });

  test('a job cannot read another organization\'s chunks, even if its document id were tampered with', async () => {
    const other = (await createIndexedDocument({ organization: orgB, owner: users.adminB, chunks: 2, tag: 'GLOBEX-ONLY' })).doc;
    const { job } = await claimed();
    await EmbeddingJob.updateOne({ _id: job.id }, { document: other._id }); // corrupted / attacked row: org A job, org B document
    const res = await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('GLOBEX-ONLY');
  });

  test.each([
    ['trashed', async (d) => Document.updateOne({ _id: d._id }, { deletedAt: new Date() }), 'DOCUMENT_DELETED'],
    ['superseded', async (d) => addVersion(d, Buffer.from('new content')), 'SUPERSEDED'],
    ['no longer extracted', async (d) => DocumentIngestionJob.updateOne({ document: d._id }, { status: 'failed' }), 'INGESTION_NOT_INDEXED'],
  ])('a %s document is not served, the job is skipped, and its vectors are queued for removal', async (_n, mutate, reason) => {
    const { doc, job } = await claimed();
    await mutate(doc);
    const res = await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(reason);
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'skipped', reason });
    if (reason !== 'INGESTION_NOT_INDEXED') expect(await EmbeddingJob.findOne({ document: doc._id, kind: 'purge' })).toBeTruthy();
  });

  test('an organization that switched AI off mid-job is not served', async () => {
    const { job } = await claimed();
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    expect((await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken })).status).toBe(409);
  });

  test('paging parameters are bounded', async () => {
    const { job } = await claimed();
    for (const query of [{ limit: 5000 }, { limit: 0 }, { after: -9 }, { after: 'x' }]) {
      expect((await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken, query })).status).toBe(400);
    }
    const big = await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken, query: { limit: 200 } });
    expect(big.status).toBe(200);
  });
});

describe('heartbeat', () => {
  test('extends the lease; a lost lock answers 409', async () => {
    const { job } = await claimed();
    await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: job.lockToken } }).expect(200);
    expect((await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: 'z'.repeat(40) } })).status).toBe(409);
    expect((await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: 'short' } })).status).toBe(400);
  });
});

describe('results', () => {
  test('embedded: the job completes and records only counts and a digest', async () => {
    const { doc, job } = await claimed({ chunks: 4 });
    const res = await submit(job, await okResult(doc)).expect(200);
    expect(res.body).toMatchObject({ success: true, status: 'completed', chunks: 4 });
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'completed', chunkCount: 4, digest: await digest(doc), reason: null, embeddedAt: expect.any(Date), lastVerifiedAt: expect.any(Date) });
  });

  test('re-sending an accepted result is idempotent; a different outcome is refused', async () => {
    const { doc, job } = await claimed();
    const result = await okResult(doc);
    await submit(job, result).expect(200);
    expect((await submit(job, result).expect(200)).body.duplicate).toBe(true);
    expect((await submit(job, { status: 'failed', reason: 'INTERNAL_ERROR' })).status).toBe(409);
  });

  test.each([
    ['another embedding space', (r) => { r.spaceId = E5.id; }],
    ['another model', (r) => { r.model = 'other/model'; }],
    ['another model revision', (r) => { r.revision = 'f'.repeat(40); }],
    ['different dimensions', (r) => { r.dimensions = 768; }],
    ['a different chunk count', (r) => { r.count += 1; }],
    ['a digest of a different chunk set', (r) => { r.digest = 'a'.repeat(64); }],
  ])('a result that does not match the space or the chunks is never accepted: %s', async (_n, mutate) => {
    const { doc, job } = await claimed();
    const result = await okResult(doc);
    mutate(result);
    const res = await submit(job, result);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESULT_MISMATCH');
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'failed', reason: 'RESULT_MISMATCH' });
  });

  test.each([
    ['unknown field', (r) => { r.vectors = [[1, 2]]; }],
    ['malformed digest', (r) => { r.digest = 'xyz'; }],
    ['zero count', (r) => { r.count = 0; }],
    ['bad space id format', (r) => { r.spaceId = 'NOT-HEX'; }],
    ['wrong status for the kind', (r) => { r.status = 'completed'; r.deleted = 1; r.generation = 0; }],
  ])('a malformed result is rejected: %s', async (_n, mutate) => {
    const { doc, job } = await claimed();
    const result = await okResult(doc);
    mutate(result);
    const res = await submit(job, result);
    expect([400]).toContain(res.status);
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'failed' });
  });

  test('failed results retry with backoff and finally die; Node-only reasons cannot be claimed by a worker', async () => {
    env.AI_EMBEDDING_MAX_ATTEMPTS = 2;
    const { doc } = await indexed();
    await enqueue(doc);
    await EmbeddingJob.updateOne({ document: doc._id }, { maxAttempts: 2 });
    const first = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    expect((await submit(first, { status: 'failed', reason: 'LOCK_EXPIRED' })).status).toBe(400);
    await EmbeddingJob.updateOne({ _id: first.id }, { status: 'processing', lockExpiresAt: new Date(Date.now() + 60000) });
    await submit(first, { status: 'failed', reason: 'VECTOR_STORE_UNAVAILABLE' }).expect(200);
    expect(await EmbeddingJob.findById(first.id)).toMatchObject({ status: 'failed', reason: 'VECTOR_STORE_UNAVAILABLE' });
    await EmbeddingJob.updateOne({ _id: first.id }, { nextRunAt: new Date(Date.now() - 1000) });
    const second = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    await submit(second, { status: 'failed', reason: 'EMBEDDING_UNAVAILABLE' }).expect(200);
    expect(await EmbeddingJob.findById(first.id)).toMatchObject({ status: 'dead', reason: 'EMBEDDING_UNAVAILABLE' });
  });

  test('the wrong lock, and a worker whose lease was taken over, cannot submit', async () => {
    const { doc, job } = await claimed();
    expect((await submit(job, await okResult(doc), 'q'.repeat(48))).status).toBe(409);
    await EmbeddingJob.updateOne({ _id: job.id }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await submit(job, await okResult(doc))).status).toBe(409);
    await jobs.recoverStale();
    await EmbeddingJob.updateOne({ _id: job.id }, { nextRunAt: new Date(Date.now() - 1000) });
    const fresh = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    expect((await submit(job, await okResult(doc))).status).toBe(409); // the zombie
    await submit(fresh, await okResult(doc)).expect(200);
  });

  test.each([
    ['trashed', async (d) => Document.updateOne({ _id: d._id }, { deletedAt: new Date() }), 'DOCUMENT_DELETED', null],
    ['replaced by a new version', async (d) => addVersion(d, Buffer.from('replacement')), 'SUPERSEDED', 2],
  ])('the document was %s while the worker worked: result refused and the vectors it wrote are queued for removal', async (_n, mutate, reason, keep) => {
    const { doc, job } = await claimed();
    const result = await okResult(doc);
    await mutate(doc);
    const res = await submit(job, result);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(reason);
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'skipped', reason });
    expect(await EmbeddingJob.findOne({ document: doc._id, kind: 'purge' })).toMatchObject({ status: 'queued', keepVersion: keep });
  });

  test('trashed in the instant between the checks and the commit: the completion is undone', async () => {
    const { doc, job } = await claimed();
    const result = await okResult(doc);
    const real = EmbeddingJob.findOneAndUpdate.bind(EmbeddingJob);
    jest.spyOn(EmbeddingJob, 'findOneAndUpdate').mockImplementation(async (...args) => {
      const out = await real(...args);
      if (out && out.status === 'completed') await Document.updateOne({ _id: doc._id }, { deletedAt: new Date() });
      return out;
    });
    expect((await submit(job, result)).status).toBe(409);
    expect(await EmbeddingJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
    expect(await EmbeddingJob.findOne({ document: doc._id, kind: 'purge' })).toBeTruthy();
  });

  test('purge: completes, is idempotent, and a re-request that raced it runs again', async () => {
    const { doc } = await indexed();
    await Document.deleteOne({ _id: doc._id });
    await jobs.enqueuePurge({ organization: orgA._id, document: doc._id, spaceId: FAKE.id });
    const job = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    await jobs.enqueuePurge({ organization: orgA._id, document: doc._id, spaceId: FAKE.id, keepVersion: null }); // asked again while running
    const first = await submit(job, { status: 'completed', deleted: 3, generation: job.generation }).expect(200);
    expect(first.body.status).toBe('requeued');
    const again = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    expect(again.generation).toBe(2);
    await submit(again, { status: 'completed', deleted: 0, generation: again.generation }).expect(200);
    expect(await EmbeddingJob.countDocuments({ document: doc._id })).toBe(0); // the document is gone: nothing remains
  });

  test('purge racing a restore: the live document\'s embedding is put back to work', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const j = await EmbeddingJob.findOne({ document: doc._id });
    await EmbeddingJob.updateOne({ _id: j._id }, { status: 'completed', digest: await digest(doc), chunkCount: 3 });
    await jobs.enqueuePurge({ organization: orgA._id, document: doc._id, spaceId: FAKE.id, keepVersion: null });
    const p = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    await submit(p, { status: 'completed', deleted: 3, generation: p.generation }).expect(200);
    expect(await EmbeddingJob.findById(j._id)).toMatchObject({ status: 'queued', source: 'verify' });
  });

  test('the routine clean-up after a new version does NOT loop: embed -> purge (keeps current) -> nothing more to do', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const first = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
    await submit(first, await okResult(doc)).expect(200);
    await Document.updateOne({ _id: doc._id }, { currentVersion: 2 });
    await DocumentIngestionJob.create({ organization: orgA._id, document: doc._id, version: 2, pipelineVersion: 'p2', checksum: 'c'.repeat(64), status: 'indexed' });
    await DocumentChunk.insertMany([{ organization: orgA._id, document: doc._id, version: 2, pipelineVersion: 'p2', chunkIndex: 0, text: 'v2 text', textHash: crypto.createHash('sha256').update('v2 text').digest('hex'), tokenEstimate: 2, location: {} }]);
    await Document.updateOne({ _id: doc._id }, { checksum: 'c'.repeat(64) });
    await enqueue({ ...doc.toObject(), currentVersion: 2, organization: doc.organization, _id: doc._id });
    for (let step = 0; step < 6; step += 1) {
      // eslint-disable-next-line no-await-in-loop
      const j = (await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job;
      if (!j) break;
      if (j.kind === 'embed') {
        // eslint-disable-next-line no-await-in-loop
        await submit(j, { status: 'embedded', spaceId: FAKE.id, model: FAKE.descriptor.model, revision: FAKE.descriptor.revision, dimensions: 384, count: 1, digest: spaces.digestOf([crypto.createHash('sha256').update('v2 text').digest('hex')]) }).expect(200);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await submit(j, { status: 'completed', deleted: 3, generation: j.generation }).expect(200);
      }
    }
    expect((await call('post', '/claim', { body: { spaceId: FAKE.id, ingestionPipeline: 'p2' } })).body.job).toBeNull(); // it settled
    expect(await EmbeddingJob.countDocuments({ kind: 'embed', status: 'queued' })).toBe(0);
  });

  test('a purge result for an embed job (or vice versa) is refused', async () => {
    const { job } = await claimed();
    expect((await submit(job, { status: 'completed', deleted: 1, generation: 0 })).status).toBe(400);
  });
});

describe('no document content in logs, admin responses or errors', () => {
  test('a full lifecycle plus failures never logs or returns chunk text, names or lock tokens', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const named = await createIndexedDocument({ organization: orgA, owner: users.ownerA, name: 'SECRET-NAME-layoffs.txt', visibility: 'private', content: Buffer.from(SECRET), tag: SECRET });
    const { job } = await claimed({ doc: named.doc });
    const responses = [await call('get', `/jobs/${job.id}/chunks`, { lock: job.lockToken })];
    responses.push(await submit(job, { status: 'embedded', spaceId: FAKE.id, model: 'x', revision: 'y', dimensions: 1, count: 1, digest: 'b'.repeat(64) }));
    responses.push(await call('post', `/jobs/${job.id}/result`, { body: 'not json at all' }));
    responses.push(await as('adminA').get('/api/v1/ai/knowledge/embedding/jobs'));
    responses.push(await as('adminA').get('/api/v1/ai/knowledge/embedding'));
    const logged = spaces && spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
    const returned = JSON.stringify(responses.slice(1).map((r) => r.body));
    for (const secret of ['BOARD-CONFIDENTIAL', 'SECRET-NAME', job.lockToken]) {
      expect(logged).not.toContain(secret);
      expect(returned).not.toContain(secret);
    }
  });

  test('an unexpected error answers generically and logs only an error name', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { doc, job } = await claimed();
    jest.spyOn(DocumentChunk, 'find').mockImplementation(() => { throw new Error(`db exploded near ${SECRET}`); });
    const res = await submit(job, await okResult(doc).catch(() => ({ status: 'embedded', spaceId: FAKE.id, model: 'm', revision: 'r', dimensions: 384, count: 1, digest: 'a'.repeat(64) })));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.stack).toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).not.toContain(SECRET);
  });
});

describe('tenant administration (MANAGE_AI_KNOWLEDGE)', () => {
  const api = (p = '') => `/api/v1/ai/knowledge/embedding${p}`;

  test('overview: this organization\'s numbers only, ids/counts/statuses, no names, no platform internals', async () => {
    const mine = (await indexed({ name: 'PRIVATE-SALARIES.txt', visibility: 'private' })).doc;
    await enqueue(mine);
    await enqueue((await createIndexedDocument({ organization: orgB, owner: users.adminB })).doc);
    const o = (await as('adminA').get(api()).expect(200)).body.embedding;
    expect(o.bySpace[FAKE.id].embed.queued).toBe(1);
    expect(o).toMatchObject({ workerConfigured: true, embeddingPipeline: 'e1', migrationInProgress: true, targetCoverage: { eligible: 1, embedded: 0 } });
    const raw = JSON.stringify(o);
    for (const needle of ['PRIVATE-SALARIES', 'history', 'retiring', 'blocked', 'lockToken']) expect(raw).not.toContain(needle);
    expect((await as('adminB').get(api()).expect(200)).body.embedding.targetCoverage).toMatchObject({ eligible: 1 });
  });

  test('job list: filters, pagination, validation, tenant isolation', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue((await indexed()).doc);
    await enqueue((await createIndexedDocument({ organization: orgB, owner: users.adminB })).doc);
    expect((await as('adminA').get(api('/jobs?status=queued&limit=2')).expect(200)).body).toMatchObject({ total: 3, limit: 2 });
    expect((await as('adminB').get(api('/jobs')).expect(200)).body.total).toBe(1);
    expect((await as('adminA').get(api(`/jobs?spaceId=${FAKE.id}&kind=embed`)).expect(200)).body.total).toBe(3);
    const item = (await as('adminA').get(api('/jobs')).expect(200)).body.items[0];
    expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['name', 'text', 'digest', 'lockToken']));
    for (const bad of ['status=nope', 'kind=x', 'spaceId=zzz', 'limit=1000', 'page=0', 'x=1', 'reason=%24ne']) await as('adminA').get(api(`/jobs?${bad}`)).expect(400);
  });

  test('retry is audited, tenant-scoped and refuses what cannot be retried', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const j = await EmbeddingJob.findOne({ document: doc._id });
    await EmbeddingJob.updateOne({ _id: j._id }, { status: 'dead', reason: 'EMBEDDING_UNAVAILABLE' });
    await as('adminB').post(api(`/jobs/${j._id}/retry`)).expect(404);
    const res = await as('adminA').post(api(`/jobs/${j._id}/retry`)).expect(200);
    expect(res.body.job).toMatchObject({ status: 'queued', attempts: 0 });
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_EMBEDDING_RETRIED }).lean();
    expect(audit.organization.toString()).toBe(orgA._id.toString());
    await as('adminA').post(api(`/jobs/${j._id}/retry`)).expect(409);
  });

  test('reconcile back-fills this organization and verify re-queues only this organization\'s completed jobs', async () => {
    await indexed(); await indexed();
    const rec = (await as('adminA').post(api('/reconcile')).expect(200)).body.result;
    expect(rec).toMatchObject({ examined: 2, enqueued: 2, completed: true });
    expect(await EmbeddingJob.countDocuments({ organization: orgA._id })).toBe(2);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_EMBEDDING_RECONCILED })).toBe(1);
    await EmbeddingJob.updateMany({ organization: orgA._id }, { status: 'completed' });
    const other = (await createIndexedDocument({ organization: orgB, owner: users.adminB })).doc;
    await enqueue(other);
    await EmbeddingJob.updateOne({ document: other._id }, { status: 'completed' });
    expect((await as('adminA').post(api('/verify')).expect(200)).body.result.requeued).toBe(2);
    expect((await EmbeddingJob.findOne({ document: other._id })).status).toBe('completed'); // untouched
  });

  test.each(['ownerA', 'hrA', 'managerA', 'guestA', 'superadmin'])('%s has no access to tenant embedding administration', async (key) => {
    await as(key).get(api()).expect(403);
    await as(key).get(api('/jobs')).expect(403);
    await as(key).post(api('/reconcile')).expect(403);
    await as(key).post(api('/verify')).expect(403);
  });

  test('tenant admins cannot move the platform-wide embedding pointer', async () => {
    for (const p of ['/platform/embedding', '/platform/embedding/migration/promote', '/platform/embedding/migration/abandon', '/platform/embedding/migration/start']) {
      const m = p.endsWith('embedding') ? 'get' : 'post';
      await as('adminA')[m](`/api/v1/ai${p}`).expect(403);
    }
    await as('adminA').post(api('/migration/promote')).expect(404); // and there is no tenant route for it
    expect((await spaces.ensureConfig()).activeSpaceId).toBeNull();
  });

  test('unauthenticated requests are refused', async () => {
    const { createApp } = require('../../src/app');
    expect((await request(createApp()).get(api())).status).toBe(401);
    expect((await request(createApp()).get('/api/v1/ai/platform/embedding')).status).toBe(401);
  });
});

describe('platform administration (super-admin): the embedding space and its migration', () => {
  const api = (p = '') => `/api/v1/ai/platform/embedding${p}`;

  async function populate(spaceId = FAKE.id) {
    const { doc } = await indexed();
    await enqueue(doc, { spaceId });
    const j = await EmbeddingJob.findOne({ document: doc._id, spaceId });
    await EmbeddingJob.updateOne({ _id: j._id }, { status: 'completed', digest: await digest(doc), chunkCount: 3, lastVerifiedAt: new Date() });
    return doc;
  }

  test('shows the configuration, coverage and whether promotion is possible', async () => {
    await populate();
    const o = (await as('superadmin').get(api()).expect(200)).body.embedding;
    expect(o).toMatchObject({ configuredSpace: { spaceId: FAKE.id, dimensions: 384 }, activeSpace: null, targetSpace: { spaceId: FAKE.id }, targetCoverage: { eligible: 1, embedded: 1 }, migrationReady: true, migrationProblems: [] });
  });

  test('promote switches the active space once it is complete, is audited without an organization, and is refused when not ready', async () => {
    const doc = await populate();
    await enqueue((await indexed()).doc); // a second document that is not embedded yet
    const refused = await as('superadmin').post(api('/migration/promote')).expect(409);
    expect(refused.body).toMatchObject({ code: 'EMBEDDING_MIGRATION_NOT_READY', details: { problems: expect.arrayContaining(['INCOMPLETE_COVERAGE']) } });
    expect((await spaces.getConfig()).activeSpaceId).toBeNull();
    await EmbeddingJob.updateMany({ status: 'queued' }, { status: 'completed', digest: 'x', chunkCount: 0 });
    // make the digest honest for every row so the spot check passes
    for (const j of await EmbeddingJob.find({ kind: 'embed' })) {
      // eslint-disable-next-line no-await-in-loop
      const chunks = await DocumentChunk.find({ document: j.document, version: 1 }).sort({ chunkIndex: 1 }).lean();
      // eslint-disable-next-line no-await-in-loop
      await EmbeddingJob.updateOne({ _id: j._id }, { digest: spaces.digestOf(chunks.map((c) => c.textHash)), chunkCount: chunks.length });
    }
    const ok = await as('superadmin').post(api('/migration/promote')).expect(200);
    expect(ok.body.result.activeSpace).toMatchObject({ spaceId: FAKE.id });
    expect(await spaces.activeSpaceIds()).toEqual([FAKE.id]);
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_EMBEDDING_SPACE_PROMOTED }).lean();
    expect(audit.organization).toBeNull();
    void doc;
  });

  test('abandon and start are audited', async () => {
    await spaces.ensureConfig();
    const res = await as('superadmin').post(api('/migration/abandon')).expect(200);
    expect(res.body.result.abandoned).toBe(FAKE.id);
    await as('superadmin').post(api('/migration/abandon')).expect(409);
    await as('superadmin').post(api('/migration/start')).expect(200);
    expect((await spaces.getConfig()).targetSpaceId).toBe(FAKE.id);
    expect(await AuditLog.countDocuments({ action: { $in: [AUDIT_EVENTS.AI_EMBEDDING_MIGRATION_ABANDONED, AUDIT_EVENTS.AI_EMBEDDING_MIGRATION_STARTED] } })).toBe(2);
  });

  test('only the platform operator may see or change it', async () => {
    for (const key of ['ownerA', 'adminA', 'hrA', 'adminB']) await as(key).get(api()).expect(403);
  });
});
