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
 * The Python worker's view of Node (internal listener) and the administrator's view (public API).
 * Focus: authentication, job/lock binding, live re-checks, result validation, chunk persistence, isolation,
 * and that no document content ever reaches logs or admin responses.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createStoredDocument, createWorkerKeys, ensureIndexes, sha256, signWorkerToken } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const { INGESTION_PIPELINE_VERSION: PIPELINE } = require('../../src/constants/ingestion.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AuditLog = require('../../src/models/AuditLog');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const jobs = require('../../src/services/ai/ingestion/ingestionJobs.service');
const { getStorage } = require('../../src/storage');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser, makeAgent, as } = createHarness();
const internal = createInternalApp();
const keys = createWorkerKeys();
const foreign = createWorkerKeys();
const oid = () => new mongoose.Types.ObjectId();
const KEYS = ['ownerA', 'adminA', 'hrA', 'managerA', 'guestA', 'adminB'];
const SECRET_TEXT = 'BOARD-CONFIDENTIAL layoffs planned for Q3';
const saved = {};
let orgA; let orgB;

const tok = (over) => signWorkerToken(keys.privatePem, over);
const call = (method, path, { token = tok(), body, lock } = {}) => {
  let req = request(internal)[method](`/internal/ingestion${path}`);
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
const doc = (over = {}) => createStoredDocument({ organization: orgA, owner: users.ownerA, ...over });
const enqueue = (d) => jobs.enqueue({ organization: d.organization, document: d._id, version: d.currentVersion, extension: d.extension, size: d.size, checksum: d.checksum });

async function claimOver(d, content) {
  const document = d || (await doc(content ? { content } : {}));
  await enqueue(document);
  const res = await call('post', '/claim', { body: { workerId: 'w-test', pipelineVersion: PIPELINE } }).expect(200);
  return { document, job: res.body.job };
}

function indexedResult(text = 'A short paragraph of text.', over = {}) {
  const chunks = [{ index: 0, text, textHash: sha256(Buffer.from(text)), tokenEstimate: Math.ceil(text.length / 4), location: { charStart: 0, charEnd: text.length } }];
  return { status: 'indexed', format: 'txt', pipelineVersion: PIPELINE, stats: { textChars: text.length }, chunks, ...over };
}
const submit = (job, result, lock = job.lockToken) => call('post', `/jobs/${job.id}/result`, { body: { lockToken: lock, result } });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(KEYS.map(makeAgent));
  for (const k of ['AI_WORKER_PUBLIC_KEY', 'AI_WORKER_PUBLIC_KEY_FILE', 'AI_WORKER_KEY_ID', 'AI_INGEST_LEASE_SECONDS', 'AI_INGEST_MAX_ATTEMPTS']) saved[k] = env[k];
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
  await Promise.all([AiOrgSettings, AuditLog, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, Organization, User].map((m) => m.deleteMany({})));
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
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
});

describe('worker authentication', () => {
  test.each([
    ['no token', { token: null }],
    ['garbage', { token: 'not.a.jwt' }],
    ['signed by a different key', { token: signWorkerToken(foreign.privatePem) }],
    ['wrong audience (a generate token is useless here)', { token: tok({ aud: 'syncos-ai:generate' }) }],
    ['wrong issuer', { token: tok({ iss: 'syncos-node' }) }],
    ['unknown key id', { token: tok({ kid: 'w9' }) }],
    ['expired', { token: tok({ lifetime: -120 }) }],
    ['lifetime too long', { token: tok({ lifetime: 3600 }) }],
    ['HS256 signed with the public key (algorithm confusion)', { token: tok({ alg: 'HS256', key: keys.publicPem }) }],
    ['alg none', { token: `${Buffer.from('{"alg":"none","typ":"JWT","kid":"w1"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'syncos-ai-worker', aud: 'syncos-node:ingestion', sub: 'x', jti: 'a'.repeat(20), exp: 9999999999, iat: 1, nbf: 1 })).toString('base64url')}.` }],
    ['no jti', { token: tok({ claims: { jti: undefined } }) }],
  ])('%s => 401, nothing happens', async (_n, opts) => {
    const d = await doc();
    await enqueue(d);
    const res = await call('post', '/claim', { ...opts, body: { pipelineVersion: PIPELINE } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INGESTION_UNAUTHORIZED');
    expect(await DocumentIngestionJob.countDocuments({ status: 'processing' })).toBe(0);
  });

  test('a token is single use: replaying it is refused', async () => {
    const t = tok();
    await call('post', '/claim', { token: t, body: { pipelineVersion: PIPELINE } }).expect(200);
    expect((await call('post', '/claim', { token: t, body: { pipelineVersion: PIPELINE } })).status).toBe(401);
  });

  test('concurrent replays of one token succeed exactly once', async () => {
    const t = tok();
    const results = await Promise.all(Array.from({ length: 12 }, () => call('post', '/claim', { token: t, body: { pipelineVersion: PIPELINE } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(11);
  });

  test('without a configured worker key the endpoints are disabled (503), not open', async () => {
    env.AI_WORKER_PUBLIC_KEY = '';
    expect((await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).status).toBe(503);
  });

  test('a non-EC or malformed configured key also disables the endpoints', async () => {
    env.AI_WORKER_PUBLIC_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect((await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).status).toBe(503);
    env.AI_WORKER_PUBLIC_KEY = 'garbage';
    expect((await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).status).toBe(503);
  });

  test('fails closed when Redis cannot prove single use', async () => {
    jest.spyOn(redis(), 'set').mockRejectedValue(new Error('redis down'));
    const res = await call('post', '/claim', { body: { pipelineVersion: PIPELINE } });
    expect(res.status).toBe(503);
  });

  test('authentication happens before the body is read or parsed', async () => {
    const big = JSON.stringify({ lockToken: 'x'.repeat(32), result: { status: 'failed', pad: 'x'.repeat(2_000_000) } });
    expect(await refusedWithoutReading(request(internal).post('/internal/ingestion/jobs/abc/result').set('Content-Type', 'application/json').send(big))).toBe('refused');
  });

  test('the key can also be loaded from a file or base64', async () => {
    env.AI_WORKER_PUBLIC_KEY = Buffer.from(keys.publicPem).toString('base64');
    await call('post', '/claim', { body: { pipelineVersion: PIPELINE } }).expect(200);
  });
});

describe('claim', () => {
  test('hands out one job with exactly what the worker needs, and records the AUTHENTICATED worker id', async () => {
    const d = await doc({ ext: 'csv' });
    await enqueue(d);
    const res = await call('post', '/claim', { token: tok({ claims: { sub: 'real-worker-1' } }), body: { workerId: 'spoofed-admin', pipelineVersion: PIPELINE } }).expect(200);
    expect(res.body.job).toEqual({ id: expect.any(String), format: 'csv', size: d.size, sha256: d.checksum, lockToken: expect.any(String), leaseSeconds: env.AI_INGEST_LEASE_SECONDS, attempt: 1, pipelineVersion: PIPELINE });
    expect((await DocumentIngestionJob.findById(res.body.job.id)).lockedBy).toBe('real-worker-1');
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(d.name));
  });

  test('says null when there is nothing to do, and rejects unknown fields', async () => {
    expect((await call('post', '/claim', { body: { pipelineVersion: PIPELINE } }).expect(200)).body.job).toBeNull();
    expect((await call('post', '/claim', { body: { pipelineVersion: PIPELINE, organization: String(orgB._id) } })).status).toBe(400);
  });

  test('two workers never receive the same job', async () => {
    for (let i = 0; i < 6; i += 1) await enqueue(await doc());
    const res = await Promise.all(Array.from({ length: 20 }, () => call('post', '/claim', { body: { pipelineVersion: PIPELINE } })));
    const got = res.map((r) => r.body.job).filter(Boolean);
    expect(got).toHaveLength(6);
    expect(new Set(got.map((j) => j.id)).size).toBe(6);
  });
});

describe('content: only the claimed document, only while the claim is valid', () => {
  test('streams the exact bytes with the right headers', async () => {
    const content = crypto.randomBytes(5000);
    const { job } = await claimOver(null, content);
    const res = await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken }).buffer(true).parse((r, cb) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe('5000');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(sha256(res.body)).toBe(job.sha256);
  });

  test('the wrong, missing or someone else\'s lock token gets nothing', async () => {
    const a = await claimOver();
    const b = await claimOver();
    expect((await call('get', `/jobs/${a.job.id}/content`, { lock: b.job.lockToken })).status).toBe(409);
    expect((await call('get', `/jobs/${a.job.id}/content`)).status).toBe(409);
    expect((await call('get', `/jobs/${a.job.id}/content`, { lock: 'x'.repeat(48) })).status).toBe(409);
    expect((await call('get', `/jobs/not-an-id/content`, { lock: a.job.lockToken })).status).toBe(409);
    expect((await call('get', `/jobs/${oid()}/content`, { lock: a.job.lockToken })).status).toBe(409);
  });

  test('an unclaimed (queued) job cannot be read even with a guessed token', async () => {
    const d = await doc();
    await enqueue(d);
    const j = await DocumentIngestionJob.findOne({ document: d._id });
    expect((await call('get', `/jobs/${j._id}/content`, { lock: 'a'.repeat(48) })).status).toBe(409);
  });

  test('an expired lease stops access', async () => {
    const { job } = await claimOver();
    await DocumentIngestionJob.updateOne({ _id: job.id }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken })).status).toBe(409);
  });

  test('a trashed document is not served; the job is skipped as deleted', async () => {
    const { document, job } = await claimOver();
    await Document.updateOne({ _id: document._id }, { deletedAt: new Date() });
    expect((await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken })).status).toBe(409);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
  });

  test('an outdated version is not served after a new one lands', async () => {
    const { document, job } = await claimOver();
    await addVersion(document, Buffer.from('replacement content'));
    const res = await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUPERSEDED');
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
  });

  test('a job can never reach another organization\'s document, even if its document id were tampered', async () => {
    const other = await createStoredDocument({ organization: orgB, owner: users.adminB, content: Buffer.from('GLOBEX-ONLY secrets') });
    const { job } = await claimOver();
    await DocumentIngestionJob.updateOne({ _id: job.id }, { document: other._id }); // simulated corruption / attack on the row
    const res = await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('GLOBEX-ONLY');
  });

  test('a missing blob fails the job with a clear reason instead of hanging', async () => {
    const { document, job } = await claimOver();
    const v = await DocumentVersion.findOne({ document: document._id }).select('+storageKey');
    await getStorage().remove(v.storageKey);
    expect((await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken })).status).toBe(409);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'failed', reason: 'STORAGE_MISSING' });
  });

  test('a version whose recorded checksum differs from the job is not served', async () => {
    const { document, job } = await claimOver();
    await DocumentVersion.updateOne({ document: document._id }, { checksum: 'd'.repeat(64) });
    expect((await call('get', `/jobs/${job.id}/content`, { lock: job.lockToken })).status).toBe(409);
  });
});

describe('heartbeat', () => {
  test('extends the lease; a lost lock answers 409 so the worker stops', async () => {
    const { job } = await claimOver();
    await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: job.lockToken } }).expect(200);
    expect((await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: 'z'.repeat(40) } })).status).toBe(409);
    expect((await call('post', `/jobs/${job.id}/heartbeat`, { body: { lockToken: 'short' } })).status).toBe(400);
  });
});

describe('submitting results', () => {
  test('indexed: chunks are stored with their metadata and the job is marked indexed', async () => {
    const { document, job } = await claimOver();
    const text = 'Annual leave is 24 days.';
    const res = await submit(job, indexedResult(text, { stats: { textChars: text.length, pages: 1 } })).expect(200);
    expect(res.body).toMatchObject({ success: true, status: 'indexed', chunks: 1 });
    const row = await DocumentChunk.findOne({ document: document._id }).lean();
    expect(row).toMatchObject({ organization: orgA._id, version: 1, pipelineVersion: PIPELINE, chunkIndex: 0, text, textHash: sha256(Buffer.from(text)), tokenEstimate: 6 });
    expect(row.location).toMatchObject({ charStart: 0, charEnd: text.length });
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'indexed', reason: null, stats: { chunkCount: 1, pages: 1 }, finishedAt: expect.any(Date) });
  });

  test('every location field survives the round trip', async () => {
    const { document, job } = await claimOver();
    const text = 'x text';
    const result = indexedResult(text);
    result.chunks[0].location = { pageStart: 2, pageEnd: 3, headingPath: ['Policy', 'Leave'], sheet: 'Budget', rowStart: 2, rowEnd: 40, slideStart: 1, slideEnd: 2, charStart: 0, charEnd: 6 };
    await submit(job, result).expect(200);
    expect((await DocumentChunk.findOne({ document: document._id }).lean()).location).toEqual(result.chunks[0].location);
  });

  test('re-submitting the same result is idempotent (a lost response is safe to retry)', async () => {
    const { document, job } = await claimOver();
    await submit(job, indexedResult()).expect(200);
    const again = await submit(job, indexedResult()).expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(1);
    expect((await submit(job, { status: 'skipped', reason: 'EMPTY' })).status).toBe(409); // but a DIFFERENT outcome is refused
  });

  test('chunk rows are unique per (org, document, version, pipeline, index)', async () => {
    const { document, job } = await claimOver();
    await submit(job, indexedResult()).expect(200);
    await expect(DocumentChunk.create({ organization: orgA._id, document: document._id, version: 1, pipelineVersion: PIPELINE, chunkIndex: 0, text: 'dup', textHash: 'a'.repeat(64), tokenEstimate: 1 })).rejects.toMatchObject({ code: 11000 });
  });

  test('a smaller re-index removes the old tail; a new version replaces the old version\'s chunks', async () => {
    const { document, job } = await claimOver();
    const three = indexedResult();
    three.chunks = ['one', 'two', 'three'].map((text, index) => ({ index, text, textHash: sha256(Buffer.from(text)), tokenEstimate: 1, location: {} }));
    await submit(job, three).expect(200);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(3);

    // administrator re-run of the same version with a result that has only one chunk
    await DocumentIngestionJob.updateOne({ _id: job.id }, { status: 'queued', nextRunAt: new Date() });
    const again = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    await submit(again, indexedResult('only one now')).expect(200);
    expect((await DocumentChunk.find({ document: document._id }).lean()).map((c) => c.text)).toEqual(['only one now']);

    const v2 = await addVersion(document, Buffer.from('version two text'));
    await enqueue(v2);
    const next = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    await submit(next, indexedResult('version two chunk')).expect(200);
    const rows = await DocumentChunk.find({ document: document._id }).lean();
    expect(rows.map((c) => [c.version, c.text])).toEqual([[2, 'version two chunk']]);
  });

  test('skipped results carry their reason and leave no chunks behind', async () => {
    for (const reason of ['ENCRYPTED', 'NO_EXTRACTABLE_TEXT', 'EMPTY', 'CORRUPT', 'TOO_MUCH_TEXT', 'ARCHIVE_LIMIT', 'FILE_TOO_LARGE', 'UNSUPPORTED_FORMAT']) {
      const { document, job } = await claimOver();
      await DocumentChunk.create({ organization: orgA._id, document: document._id, version: 1, pipelineVersion: PIPELINE, chunkIndex: 0, text: 'stale', textHash: 'a'.repeat(64), tokenEstimate: 1 });
      await submit(job, { status: 'skipped', reason, format: 'pdf', pipelineVersion: PIPELINE }).expect(200);
      expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason });
      expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
    }
  });

  test('failed results retry with backoff and finally die; attempts are counted by claims', async () => {
    env.AI_INGEST_MAX_ATTEMPTS = 2;
    const d = await doc();
    await enqueue(d);
    await DocumentIngestionJob.updateOne({ document: d._id }, { maxAttempts: 2 });
    const first = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    await submit(first, { status: 'failed', reason: 'EXTRACTION_TIMEOUT' }).expect(200);
    expect(await DocumentIngestionJob.findById(first.id)).toMatchObject({ status: 'failed', reason: 'EXTRACTION_TIMEOUT', attempts: 1 });
    await DocumentIngestionJob.updateOne({ _id: first.id }, { nextRunAt: new Date(Date.now() - 1000) });
    const second = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    expect(second.attempt).toBe(2);
    await submit(second, { status: 'failed', reason: 'EXTRACTION_CRASHED' }).expect(200);
    expect(await DocumentIngestionJob.findById(first.id)).toMatchObject({ status: 'dead', reason: 'EXTRACTION_CRASHED' });
  });

  test.each([
    ['non-contiguous chunk indexes', (r) => { r.chunks[0].index = 5; }],
    ['a hash that does not match the text', (r) => { r.chunks[0].textHash = 'b'.repeat(64); }],
    ['an oversized chunk', (r) => { const t = 'y'.repeat(9000); r.chunks[0].text = t; r.chunks[0].textHash = sha256(Buffer.from(t)); }],
    ['an empty chunk', (r) => { r.chunks[0].text = ''; }],
    ['no chunks', (r) => { r.chunks = []; }],
    ['an unknown location key', (r) => { r.chunks[0].location = { evil: 1 }; }],
    ['a negative number', (r) => { r.chunks[0].location = { pageStart: -1 }; }],
    ['an extra top-level field', (r) => { r.organization = 'x'; }],
    ['a format that does not match the job', (r) => { r.format = 'pdf'; }],
    ['another pipeline version', (r) => { r.pipelineVersion = 'p9'; }],
  ])('a malformed result is rejected and nothing is stored: %s', async (_n, mutate) => {
    const { document, job } = await claimOver();
    const result = indexedResult();
    mutate(result);
    const res = await submit(job, result);
    expect(res.status).toBe(400);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'failed', reason: 'INTERNAL_ERROR' });
  });

  test('a worker cannot claim Node-only reasons (SUPERSEDED / DOCUMENT_DELETED) or unknown ones', async () => {
    for (const reason of ['SUPERSEDED', 'DOCUMENT_DELETED', 'WHATEVER']) {
      const { job } = await claimOver();
      expect((await submit(job, { status: 'skipped', reason })).status).toBe(400);
    }
  });

  test('the wrong lock token cannot submit, and cannot read the result of a finished job either', async () => {
    const { document, job } = await claimOver();
    expect((await submit(job, indexedResult(), 'q'.repeat(48))).status).toBe(409);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
  });

  test('a lease that expired and was re-claimed fences the old worker out', async () => {
    const { document, job } = await claimOver();
    await DocumentIngestionJob.updateOne({ _id: job.id }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await submit(job, indexedResult('late result'))).status).toBe(409);
    await jobs.recoverStale();
    await DocumentIngestionJob.updateOne({ _id: job.id }, { nextRunAt: new Date(Date.now() - 1000) });
    const fresh = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    expect((await submit(job, indexedResult('zombie'))).status).toBe(409);
    await submit(fresh, indexedResult('real result')).expect(200);
    expect((await DocumentChunk.find({ document: document._id }).lean()).map((c) => c.text)).toEqual(['real result']);
  });

  test('the document was trashed while the worker worked: result refused, nothing stored', async () => {
    const { document, job } = await claimOver();
    await Document.updateOne({ _id: document._id }, { deletedAt: new Date() });
    const res = await submit(job, indexedResult());
    expect(res.status).toBe(409);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
  });

  test('a new version landed while the worker worked: the stale result is refused and never becomes current', async () => {
    const { document, job } = await claimOver();
    await addVersion(document, Buffer.from('a brand new version'));
    const res = await submit(job, indexedResult('text of the OLD version'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUPERSEDED');
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
  });

  test('trashed in the instant between the checks and the final write: chunks are rolled back', async () => {
    const { document, job } = await claimOver();
    const realUpdate = DocumentIngestionJob.findOneAndUpdate.bind(DocumentIngestionJob);
    jest.spyOn(DocumentIngestionJob, 'findOneAndUpdate').mockImplementation(async (...args) => {
      const out = await realUpdate(...args);
      if (out && out.status === 'indexed') await Document.updateOne({ _id: document._id }, { deletedAt: new Date() }); // lands right after the commit
      return out;
    });
    const res = await submit(job, indexedResult());
    expect(res.status).toBe(409);
    expect(await DocumentChunk.countDocuments({ document: document._id })).toBe(0);
    expect(await DocumentIngestionJob.findById(job.id)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
  });

  test('chunks are stored under the JOB\'s organization, whatever the worker sends', async () => {
    const { document, job } = await claimOver();
    const result = indexedResult();
    result.chunks[0].organization = String(orgB._id);
    expect((await submit(job, result)).status).toBe(400); // unknown field
    await DocumentIngestionJob.updateOne({ _id: job.id }, { status: 'processing', lockExpiresAt: new Date(Date.now() + 60000) });
    await submit(job, indexedResult()).expect(200);
    expect((await DocumentChunk.findOne({ document: document._id })).organization.toString()).toBe(orgA._id.toString());
  });
});

describe('no document content in logs or error responses', () => {
  test('a full lifecycle plus failures logs and returns no document text, names or lock tokens', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const named = await doc({ name: 'SECRET-NAME-layoffs.txt', content: Buffer.from(SECRET_TEXT) });
    const { job } = await claimOver(named);
    const responses = [];
    responses.push(await submit(job, indexedResult(SECRET_TEXT)));
    responses.push(await submit(job, { status: 'skipped', reason: 'WHATEVER' }));
    responses.push(await submit(job, { ...indexedResult(SECRET_TEXT), chunks: [{ index: 9, text: SECRET_TEXT }] }));
    responses.push(await call('post', `/jobs/${job.id}/result`, { body: 'not json at all' }));
    const second = await claimOver();
    responses.push(await submit(second.job, indexedResult(SECRET_TEXT, { chunks: [] })));
    const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
    const returned = JSON.stringify(responses.map((r) => r.body));
    for (const secret of [SECRET_TEXT, 'BOARD-CONFIDENTIAL', 'SECRET-NAME', job.lockToken]) {
      expect(logged).not.toContain(secret);
      expect(returned).not.toContain(secret);
    }
  });

  test('unexpected errors answer with a generic 500 and log only an error name', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { job } = await claimOver();
    jest.spyOn(DocumentChunk, 'bulkWrite').mockRejectedValue(new Error(`db exploded near ${SECRET_TEXT}`));
    const res = await submit(job, indexedResult(SECRET_TEXT));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TEXT);
    expect(res.body.stack).toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).not.toContain(SECRET_TEXT);
  });
});

describe('administration (MANAGE_AI_KNOWLEDGE)', () => {
  const api = (p = '') => `/api/v1/ai/knowledge/ingestion${p}`;

  test('overview and job list show counts, statuses and reasons - never names or text', async () => {
    const priv = await doc({ name: 'PRIVATE-SALARIES.txt', visibility: 'private', content: Buffer.from(SECRET_TEXT) });
    await enqueue(priv);
    const png = await doc({ ext: 'png' });
    await enqueue(png);
    const overview = (await as('adminA').get(api()).expect(200)).body.ingestion;
    expect(overview).toMatchObject({ aiEnabled: true, workerConfigured: true, pipelineVersion: PIPELINE, byStatus: { queued: 1, skipped: 1, indexed: 0, failed: 0, dead: 0, processing: 0 }, skippedByReason: { UNSUPPORTED_FORMAT: 1 } });
    const list = (await as('adminA').get(api('/jobs')).expect(200)).body;
    expect(list.total).toBe(2);
    expect(list.items.find((j) => j.status === 'skipped')).toMatchObject({ reason: 'UNSUPPORTED_FORMAT', reasonMessage: expect.stringContaining('not indexed') });
    const raw = JSON.stringify(list) + JSON.stringify(overview);
    for (const secret of ['PRIVATE-SALARIES', SECRET_TEXT, 'lockToken']) expect(raw).not.toContain(secret);
    expect(Object.keys(list.items[0])).not.toEqual(expect.arrayContaining(['name', 'text', 'checksum', 'lockToken']));
  });

  test('filters, pagination and validation', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue(await doc({ ext: 'png' }));
    await enqueue(await doc());
    expect((await as('adminA').get(api('/jobs?status=skipped&limit=2')).expect(200)).body).toMatchObject({ total: 3, limit: 2, items: expect.any(Array) });
    expect((await as('adminA').get(api('/jobs?status=queued')).expect(200)).body.total).toBe(1);
    expect((await as('adminA').get(api('/jobs?reason=UNSUPPORTED_FORMAT')).expect(200)).body.total).toBe(3);
    for (const bad of ['status=nope', 'limit=1000', 'page=0', 'reason=%27%24ne', 'x=1']) await as('adminA').get(api(`/jobs?${bad}`)).expect(400);
  });

  test('organizations only ever see their own jobs', async () => {
    await enqueue(await doc());
    await enqueue(await createStoredDocument({ organization: orgB, owner: users.adminB }));
    const a = (await as('adminA').get(api('/jobs')).expect(200)).body;
    const b = (await as('adminB').get(api('/jobs')).expect(200)).body;
    expect([a.total, b.total]).toEqual([1, 1]);
    expect(a.items[0].id).not.toBe(b.items[0].id);
    expect((await as('adminB').get(api()).expect(200)).body.ingestion.byStatus.queued).toBe(1);
  });

  test('retry works end to end, is audited, and is invisible across organizations', async () => {
    env.AI_INGEST_MAX_ATTEMPTS = 1;
    const d = await doc();
    await enqueue(d);
    await DocumentIngestionJob.updateOne({ document: d._id }, { maxAttempts: 1 });
    const claimed = (await call('post', '/claim', { body: { pipelineVersion: PIPELINE } })).body.job;
    await submit(claimed, { status: 'failed', reason: 'EXTRACTION_CRASHED' }).expect(200);
    expect(await DocumentIngestionJob.findById(claimed.id)).toMatchObject({ status: 'dead' });

    await as('adminB').post(api(`/jobs/${claimed.id}/retry`)).expect(404);
    const res = await as('adminA').post(api(`/jobs/${claimed.id}/retry`)).expect(200);
    expect(res.body.job).toMatchObject({ status: 'queued', attempts: 0 });
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_INGESTION_RETRIED }).lean();
    expect(audit).toMatchObject({ entityType: 'ai_ingestion_job' });
    expect(audit.organization.toString()).toBe(orgA._id.toString());
    await as('adminA').post(api(`/jobs/${claimed.id}/retry`)).expect(409); // already queued
  });

  test('reconcile back-fills existing documents and is audited', async () => {
    await doc(); await doc({ ext: 'zip' });
    const res = await as('adminA').post(api('/reconcile')).expect(200);
    expect(res.body.result).toMatchObject({ examined: 2, enqueued: 2, completed: true });
    expect(await DocumentIngestionJob.countDocuments({ organization: orgA._id })).toBe(2);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_INGESTION_RECONCILED })).toBe(1);
  });

  test.each(['ownerA', 'hrA', 'managerA', 'guestA'])('%s has no access to ingestion administration', async (key) => {
    const j = await DocumentIngestionJob.create({ organization: orgA._id, document: oid(), version: 1, pipelineVersion: PIPELINE, checksum: 'a'.repeat(64) });
    await as(key).get(api()).expect(403);
    await as(key).get(api('/jobs')).expect(403);
    await as(key).post(api(`/jobs/${j._id}/retry`)).expect(403);
    await as(key).post(api('/reconcile')).expect(403);
  });

  test('unauthenticated requests are refused', async () => {
    const { createApp } = require('../../src/app');
    expect((await request(createApp()).get(api())).status).toBe(401);
  });
});

test('the internal listener serves nothing outside its two namespaces', async () => {
  for (const [method, url] of [['get', '/health'], ['get', '/api/v1/ai/status'], ['post', '/internal/ingestion'], ['get', '/internal/ingestion/claim']]) {
    const res = await request(internal)[method](url).set('Authorization', `Bearer ${tok()}`);
    expect([401, 404]).toContain(res.status);
  }
});
