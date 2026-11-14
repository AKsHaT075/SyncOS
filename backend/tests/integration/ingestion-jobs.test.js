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
 * Job state machine (queue, claim, lease, stale recovery, retry, dead letter), reconciliation, and the hooks
 * from the real document upload / version / trash / purge code. MongoDB + Redis are real.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createStoredDocument, ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { INGESTION_PIPELINE_VERSION: PIPELINE } = require('../../src/constants/ingestion.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const jobs = require('../../src/services/ai/ingestion/ingestionJobs.service');
const reconcile = require('../../src/services/ai/ingestion/ingestionReconcile.service');
const ingestion = require('../../src/services/ai/ingestion');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const KEYS = ['ownerA', 'adminA', 'ownerB'];
const saved = {};
let orgA; let orgB; let orgC;

const doc = (over = {}) => createStoredDocument({ organization: orgA, owner: users.ownerA, ...over });
const jobOf = (d, version = d.currentVersion) => DocumentIngestionJob.findOne({ document: d._id, version }).select('+lockToken');
const enqueueDoc = (d, over = {}) => jobs.enqueue({ organization: d.organization, document: d._id, version: d.currentVersion, extension: d.extension, size: d.size, checksum: d.checksum, ...over });
const chunkRow = (d, version, index, over = {}) => ({ organization: d.organization, document: d._id, version, pipelineVersion: PIPELINE, chunkIndex: index, text: `chunk ${index}`, textHash: 'a'.repeat(64), tokenEstimate: 3, location: {}, ...over });
const expire = (job) => DocumentIngestionJob.updateOne({ _id: job._id }, { lockExpiresAt: new Date(Date.now() - 1000) });
const due = (job) => DocumentIngestionJob.updateOne({ _id: job._id }, { nextRunAt: new Date(Date.now() - 1000) });
const claim = (workerId = 'w-test') => jobs.claim({ workerId, pipelineVersion: PIPELINE });
const redis = () => createRedisClient();

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(KEYS.map(makeAgent));
  for (const k of ['AI_INGEST_MAX_FILE_MB', 'AI_INGEST_MAX_ATTEMPTS', 'AI_INGEST_LEASE_SECONDS', 'AI_INGEST_MAX_PROCESSING_SECONDS', 'AI_INGEST_BACKOFF_BASE_SECONDS', 'AI_INGEST_BACKOFF_MAX_SECONDS']) saved[k] = env[k];
});
afterAll(async () => {
  Object.assign(env, saved);
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  Object.assign(env, saved);
  await Promise.all([AiOrgSettings, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, Organization, User].map((m) => m.deleteMany({})));
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  orgC = await Organization.create({ name: 'NoAI', slug: `noai-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'ownerA', ROLES.EMPLOYEE);
  await createUser(orgA, 'adminA', ROLES.ORG_ADMIN);
  await createUser(orgB, 'ownerB', ROLES.EMPLOYEE);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]); // orgC: AI never enabled
});

describe('enqueue: duplicate prevention and up-front skips', () => {
  test('every supported format becomes queued, every other format is skipped with a reason', async () => {
    const expected = { pdf: 'queued', docx: 'queued', xlsx: 'queued', pptx: 'queued', txt: 'queued', csv: 'queued', doc: 'UNSUPPORTED_FORMAT', xls: 'UNSUPPORTED_FORMAT', ppt: 'UNSUPPORTED_FORMAT', zip: 'UNSUPPORTED_FORMAT', png: 'UNSUPPORTED_FORMAT', jpg: 'UNSUPPORTED_FORMAT' };
    for (const [ext, outcome] of Object.entries(expected)) {
      const d = await doc({ ext });
      await enqueueDoc(d);
      const j = await jobOf(d);
      if (outcome === 'queued') expect(j).toMatchObject({ status: 'queued', reason: null, format: ext, pipelineVersion: PIPELINE, version: 1, attempts: 0, checksum: d.checksum });
      else expect(j).toMatchObject({ status: 'skipped', reason: outcome, finishedAt: expect.any(Date) });
    }
  });

  test('an oversized file is skipped without ever reaching a worker', async () => {
    env.AI_INGEST_MAX_FILE_MB = 1;
    const d = await doc({ ext: 'pdf', content: Buffer.alloc(1024 * 1024 + 1, 'x') });
    await enqueueDoc(d);
    expect(await jobOf(d)).toMatchObject({ status: 'skipped', reason: 'FILE_TOO_LARGE' });
    expect(await claim()).toBeNull();
  });

  test('organizations that have not enabled AI are never ingested', async () => {
    const d = await createStoredDocument({ organization: orgC, owner: users.ownerA });
    expect(await enqueueDoc(d)).toMatchObject({ created: false, skipped: 'AI_DISABLED' });
    expect(await DocumentIngestionJob.countDocuments()).toBe(0);
  });

  test('the same (org, document, version, pipeline) can exist only once - sequentially and under a race', async () => {
    const d = await doc();
    expect((await enqueueDoc(d)).created).toBe(true);
    expect((await enqueueDoc(d)).created).toBe(false);
    const results = await Promise.all(Array.from({ length: 30 }, () => enqueueDoc(d)));
    expect(results.filter((r) => r.created)).toHaveLength(0);
    const fresh = await doc();
    const race = await Promise.all(Array.from({ length: 30 }, () => enqueueDoc(fresh)));
    expect(race.filter((r) => r.created)).toHaveLength(1);
    expect(await DocumentIngestionJob.countDocuments({ document: fresh._id })).toBe(1);
  });

  test('a new version gets its own job; another pipeline version would too', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const v2 = await addVersion(d, Buffer.from('second version of the text'));
    await enqueueDoc(v2);
    expect(await DocumentIngestionJob.countDocuments({ document: d._id })).toBe(2);
    const idx = (await DocumentIngestionJob.collection.indexes()).find((i) => i.unique && i.key.pipelineVersion);
    expect(Object.keys(idx.key)).toEqual(['organization', 'document', 'version', 'pipelineVersion']);
  });
});

describe('claim', () => {
  test('is atomic: 40 concurrent workers over 12 jobs claim each job exactly once', async () => {
    for (let i = 0; i < 12; i += 1) await enqueueDoc(await doc());
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => claim(`w${i}`)));
    const got = results.filter(Boolean);
    expect(got).toHaveLength(12);
    expect(new Set(got.map((j) => j._id.toString())).size).toBe(12);
    expect(new Set(got.map((j) => j.lockToken)).size).toBe(12);
    const all = await DocumentIngestionJob.find({});
    expect(all.every((j) => j.status === 'processing' && j.attempts === 1)).toBe(true);
  });

  test('a claim sets a lease, the worker id and the attempt count', async () => {
    await enqueueDoc(await doc());
    const j = await claim('worker-7');
    expect(j).toMatchObject({ status: 'processing', lockedBy: 'worker-7', attempts: 1 });
    expect(j.lockExpiresAt.getTime()).toBeGreaterThan(Date.now() + (env.AI_INGEST_LEASE_SECONDS - 5) * 1000);
    expect(j.lockToken).toMatch(/^[a-f0-9]{48}$/);
  });

  test('a worker built for another pipeline version gets nothing', async () => {
    await enqueueDoc(await doc());
    expect(await jobs.claim({ workerId: 'w', pipelineVersion: 'p0' })).toBeNull();
    expect(await DocumentIngestionJob.countDocuments({ status: 'queued' })).toBe(1);
  });

  test('jobs of an organization that switched AI off stay queued, uncounted, and are retried later', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    expect(await claim()).toBeNull();
    const j = await jobOf(d);
    expect(j).toMatchObject({ status: 'queued', attempts: 0 });
    expect(j.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: true });
    await due(j);
    expect(await claim()).toMatchObject({ attempts: 1 });
  });

  test('deleted (trashed) documents are never handed out', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await Document.updateOne({ _id: d._id }, { deletedAt: new Date() });
    expect(await claim()).toBeNull();
    expect(await jobOf(d)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
  });

  test('stale versions are never handed out; the current version still is', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const v2 = await addVersion(d, Buffer.from('new content for version two'));
    await enqueueDoc(v2);
    const claimed = await claim();
    expect(claimed.version).toBe(2);
    expect(await jobOf(d, 1)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
  });

  test('a checksum that no longer matches the document is treated as superseded', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await Document.updateOne({ _id: d._id }, { checksum: 'f'.repeat(64) });
    expect(await claim()).toBeNull();
    expect(await jobOf(d)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
  });

  test('older due jobs run first', async () => {
    const a = await doc(); const b = await doc();
    await enqueueDoc(a); await enqueueDoc(b);
    await DocumentIngestionJob.updateOne({ document: b._id }, { nextRunAt: new Date(Date.now() - 60000) });
    expect((await claim()).document.toString()).toBe(b._id.toString());
  });
});

describe('lease and heartbeat', () => {
  test('a heartbeat extends the lease; the wrong token, an expired lease and a finished job cannot', async () => {
    await enqueueDoc(await doc());
    const j = await claim();
    await DocumentIngestionJob.updateOne({ _id: j._id }, { lockExpiresAt: new Date(Date.now() + 5000) });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toEqual({ ok: true });
    expect((await jobOf({ _id: j.document, currentVersion: 1 })).lockExpiresAt.getTime()).toBeGreaterThan(Date.now() + 60000);
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: 'x'.repeat(48) })).toMatchObject({ ok: false, reason: 'LOCK_LOST' });
    await expire(j);
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false, reason: 'LOCK_LOST' });
  });

  test('a heartbeat cannot extend a runaway job past the processing cap', async () => {
    env.AI_INGEST_MAX_PROCESSING_SECONDS = 1;
    await enqueueDoc(await doc());
    const j = await claim();
    await DocumentIngestionJob.updateOne({ _id: j._id }, { startedAt: new Date(Date.now() - 5000) });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false, reason: 'LOCK_LOST' });
  });

  test('a document trashed or re-versioned during processing is discovered at the next heartbeat', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const j = await claim();
    await Document.updateOne({ _id: d._id }, { deletedAt: new Date() });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false, reason: 'DOCUMENT_DELETED' });
    expect(await jobOf(d)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });

    const e = await doc();
    await enqueueDoc(e);
    const j2 = await claim();
    await addVersion(e, Buffer.from('a newer version arrives'));
    expect(await jobs.heartbeat({ jobId: j2._id, lockToken: j2.lockToken })).toMatchObject({ ok: false, reason: 'SUPERSEDED' });
  });
});

describe('worker crashes and stale-lock recovery', () => {
  test('a crashed worker\'s job becomes failed with backoff, then runs again with a new token', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const first = await claim('crashy');
    await expire(first); // the worker died: no heartbeat, no result
    expect(await jobs.recoverStale()).toEqual({ dead: 0, retried: 1 });
    const failed = await jobOf(d);
    expect(failed).toMatchObject({ status: 'failed', reason: 'LOCK_EXPIRED', lockedBy: null, attempts: 1 });
    expect(failed.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claim()).toBeNull(); // not before the backoff elapses
    await due(failed);
    const second = await claim('healthy');
    expect(second).toMatchObject({ attempts: 2, lockedBy: 'healthy' });
    expect(second.lockToken).not.toBe(first.lockToken);
  });

  test('claim() itself recovers stale locks, so a lone worker is enough', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await expire(await claim());
    await claim(); // recovers it to failed (backoff pending) and finds nothing runnable
    expect(await jobOf(d)).toMatchObject({ status: 'failed', reason: 'LOCK_EXPIRED' });
  });

  test('a job that keeps killing its worker goes dead instead of looping forever', async () => {
    env.AI_INGEST_MAX_ATTEMPTS = 3;
    const d = await doc();
    await enqueueDoc(d);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const j = await claim();
      expect(j.attempts).toBe(attempt);
      await expire(j);
      await jobs.recoverStale();
      if (attempt < 3) await due(await jobOf(d));
    }
    expect(await jobOf(d)).toMatchObject({ status: 'dead', reason: 'LOCK_EXPIRED', attempts: 3 });
    expect(await claim()).toBeNull();
  });

  test('recovery is idempotent and safe to run concurrently from several instances', async () => {
    for (let i = 0; i < 5; i += 1) await enqueueDoc(await doc());
    for (let i = 0; i < 5; i += 1) await expire(await claim());
    await Promise.all([jobs.recoverStale(), jobs.recoverStale(), jobs.recoverStale()]);
    const all = await DocumentIngestionJob.find({});
    expect(all.every((j) => j.status === 'failed' && j.attempts === 1)).toBe(true);
  });

  test('a stale worker cannot overwrite the new owner: the lock token fences it', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const stale = await claim('slow');
    await expire(stale);
    await jobs.recoverStale();
    await due(await jobOf(d));
    const fresh = await claim('fast');
    expect(await jobs.heartbeat({ jobId: stale._id, lockToken: stale.lockToken })).toMatchObject({ ok: false });
    expect(await jobs.failJob({ job: stale, reason: 'EXTRACTION_CRASHED' })).toBeNull();
    expect(await jobs.skipJob({ job: stale, reason: 'EMPTY' })).toBeNull();
    expect(await jobOf(d)).toMatchObject({ status: 'processing', lockedBy: 'fast' });
    expect(fresh.lockToken).not.toBe(stale.lockToken);
  });
});

describe('retry with exponential backoff, dead letter, administrative retry', () => {
  test('backoff doubles per attempt (with jitter) up to the cap', () => {
    env.AI_INGEST_BACKOFF_BASE_SECONDS = 30;
    env.AI_INGEST_BACKOFF_MAX_SECONDS = 1800;
    for (const [attempt, nominal] of [[1, 30], [2, 60], [3, 120], [4, 240], [8, 1800], [20, 1800]]) {
      for (let i = 0; i < 20; i += 1) {
        const ms = jobs.backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual((nominal * 1000) / 2);
        expect(ms).toBeLessThanOrEqual(nominal * 1000);
      }
    }
  });

  test('transient failures retry with growing delays, then die at the attempt limit', async () => {
    env.AI_INGEST_MAX_ATTEMPTS = 3;
    const d = await doc();
    await enqueueDoc(d);
    const delays = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const j = await claim();
      const after = await jobs.failJob({ job: j, reason: 'EXTRACTION_TIMEOUT' });
      if (attempt < 3) {
        expect(after).toMatchObject({ status: 'failed', reason: 'EXTRACTION_TIMEOUT' });
        delays.push(after.nextRunAt.getTime() - Date.now());
        await due(after);
      } else {
        expect(after).toMatchObject({ status: 'dead', reason: 'EXTRACTION_TIMEOUT', finishedAt: expect.any(Date) });
      }
    }
    expect(delays[1]).toBeGreaterThan(delays[0] * 0.9); // second wait is not shorter than the first (jitter aside)
    expect(await claim()).toBeNull();
  });

  test('an administrator can retry a dead job: fresh budget, queued again, audited at the API layer', async () => {
    env.AI_INGEST_MAX_ATTEMPTS = 1;
    const d = await doc();
    await enqueueDoc(d);
    await jobs.failJob({ job: await claim(), reason: 'EXTRACTION_CRASHED' });
    const dead = await jobOf(d);
    expect(dead.status).toBe('dead');
    const retried = await jobs.retryJob({ organization: orgA._id, jobId: dead._id });
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, reason: null, source: 'admin' });
    expect(await claim()).toMatchObject({ attempts: 1 });
  });

  test('retry is refused for indexed / queued / processing jobs, stale versions and deleted documents', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const queued = await jobOf(d);
    await expect(jobs.retryJob({ organization: orgA._id, jobId: queued._id })).rejects.toMatchObject({ statusCode: 409 });
    const j = await claim();
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 409 });
    await jobs.failJob({ job: j, reason: 'EXTRACTION_CRASHED' });
    await addVersion(d, Buffer.from('another version appears'));
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 409, code: 'INGESTION_NOT_RETRYABLE' });
    await DocumentIngestionJob.updateOne({ _id: j._id }, { status: 'skipped', reason: 'DOCUMENT_DELETED' });
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('retrying a permanently skipped file (e.g. unsupported) just re-skips it with the same reason', async () => {
    const d = await doc({ ext: 'png' });
    await enqueueDoc(d);
    const j = await jobOf(d);
    const again = await jobs.retryJob({ organization: orgA._id, jobId: j._id });
    expect(again).toMatchObject({ status: 'skipped', reason: 'UNSUPPORTED_FORMAT' });
  });

  test('another organization cannot see or retry a job: it looks exactly like a missing job', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const j = await jobOf(d);
    await expect(jobs.retryJob({ organization: orgB._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(jobs.retryJob({ organization: orgB._id, jobId: oid() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(jobs.retryJob({ organization: orgB._id, jobId: 'not-an-id' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('reconciliation', () => {
  test('back-fills documents that have no job (e.g. uploaded before AI was enabled)', async () => {
    const a = await doc(); const b = await doc({ ext: 'png' });
    const r = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r).toMatchObject({ examined: 2, enqueued: 2 });
    expect(await jobOf(a)).toMatchObject({ status: 'queued', source: 'reconcile' });
    expect(await jobOf(b)).toMatchObject({ status: 'skipped', reason: 'UNSUPPORTED_FORMAT' });
    expect((await reconcile.reconcileOrganization({ organization: orgA._id })).enqueued).toBe(0); // idempotent
  });

  test('does nothing for an organization with AI off and never crosses organizations', async () => {
    await createStoredDocument({ organization: orgC, owner: users.ownerA });
    await doc();
    expect(await reconcile.reconcileOrganization({ organization: orgC._id })).toMatchObject({ skipped: 'AI_DISABLED', enqueued: 0 });
    expect(await reconcile.reconcileOrganization({ organization: orgB._id })).toMatchObject({ examined: 0 });
    expect(await DocumentIngestionJob.countDocuments({ organization: { $ne: orgA._id } })).toBe(0);
  });

  test('pages through a large library with a cursor', async () => {
    for (let i = 0; i < 7; i += 1) await doc();
    let after = null; let enqueued = 0; let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const r = await reconcile.reconcileOrganization({ organization: orgA._id, after, limit: 3 });
      enqueued += r.enqueued; after = r.cursor; pages += 1;
    } while (after);
    expect(enqueued).toBe(7);
    expect(pages).toBe(3);
  });

  test('supersedes queued work for old versions and requeues when the recorded checksum drifted', async () => {
    const d = await doc();
    await enqueueDoc(d);
    const v2 = await addVersion(d, Buffer.from('this is the new current version'));
    const r = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r).toMatchObject({ superseded: 1, enqueued: 1 });
    expect(await jobOf(d, 1)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
    expect(await jobOf(v2, 2)).toMatchObject({ status: 'queued' });

    // drift: same version number, different checksum than the job saw
    await DocumentChunk.create(chunkRow(v2, 2, 0));
    await DocumentIngestionJob.updateOne({ document: d._id, version: 2 }, { status: 'indexed', checksum: 'e'.repeat(64) });
    const r2 = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r2.requeued).toBe(1);
    expect(await jobOf(v2, 2)).toMatchObject({ status: 'queued', checksum: v2.checksum, attempts: 0 });
    expect(await DocumentChunk.countDocuments({ document: d._id })).toBe(0);
  });

  test('removes chunks and queued work of trashed documents', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await DocumentIngestionJob.updateOne({ document: d._id }, { status: 'indexed' });
    await DocumentChunk.create(chunkRow(d, 1, 0));
    await Document.updateOne({ _id: d._id }, { deletedAt: new Date() }); // e.g. a folder was trashed: no per-document hook ran
    const r = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r.removed).toBe(1);
    expect(await DocumentChunk.countDocuments({ document: d._id })).toBe(0);
  });

  test('drops chunks of old versions and old pipeline versions once the current one is indexed', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await DocumentIngestionJob.updateOne({ document: d._id }, { status: 'indexed' });
    await DocumentChunk.create([chunkRow(d, 1, 0), chunkRow(d, 1, 1, { pipelineVersion: 'p0' }), chunkRow(d, 0, 0)]);
    await reconcile.reconcileOrganization({ organization: orgA._id });
    const left = await DocumentChunk.find({ document: d._id }).lean();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ version: 1, pipelineVersion: PIPELINE });
  });

  test('revives a document restored after being trashed (folder restore never calls the per-document hook)', async () => {
    const d = await doc();
    await enqueueDoc(d);
    await Document.updateOne({ _id: d._id }, { deletedAt: new Date() });
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await jobOf(d)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
    await Document.updateOne({ _id: d._id }, { deletedAt: null });
    expect((await reconcile.reconcileOrganization({ organization: orgA._id })).requeued).toBe(1);
    expect(await jobOf(d)).toMatchObject({ status: 'queued', reason: null, attempts: 0 });
  });

  test('sweepAll covers every AI-enabled organization and no other', async () => {
    await doc();
    await createStoredDocument({ organization: orgB, owner: users.ownerB });
    await createStoredDocument({ organization: orgC, owner: users.ownerA });
    const totals = await reconcile.sweepAll();
    expect(totals).toMatchObject({ organizations: 2, enqueued: 2 });
    expect(await DocumentIngestionJob.countDocuments({ organization: orgC._id })).toBe(0);
  });
});

describe('hooks in the real document flows', () => {
  const upload = (key, name, content, type = 'text/plain') =>
    as(key).post('/api/v1/documents').attach('file', Buffer.from(content), { filename: name, contentType: type });

  test('uploading a document queues its job; unsupported types are recorded as skipped, not ignored', async () => {
    const res = await upload('ownerA', 'policy.txt', 'Our leave policy is generous.').expect(201);
    const id = res.body.document.id;
    expect(await DocumentIngestionJob.findOne({ document: id })).toMatchObject({ status: 'queued', format: 'txt', version: 1 });
    const png = await as('ownerA').post('/api/v1/documents').attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), { filename: 'logo.png', contentType: 'image/png' }).expect(201);
    expect(await DocumentIngestionJob.findOne({ document: png.body.document.id })).toMatchObject({ status: 'skipped', reason: 'UNSUPPORTED_FORMAT' });
  });

  test('an upload by an organization with AI off creates no job (and no chunk store entries)', async () => {
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    await upload('ownerA', 'quiet.txt', 'nothing indexed here').expect(201);
    expect(await DocumentIngestionJob.countDocuments()).toBe(0);
  });

  test('uploading a new version supersedes the old version\'s queued job; restoring an old version re-queues as a new version', async () => {
    const id = (await upload('ownerA', 'v.txt', 'version one text').expect(201)).body.document.id;
    await as('ownerA').post(`/api/v1/documents/${id}/versions`).attach('file', Buffer.from('version two text'), { filename: 'v.txt', contentType: 'text/plain' }).expect(201);
    expect(await DocumentIngestionJob.countDocuments({ document: id })).toBe(2);
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await DocumentIngestionJob.findOne({ document: id, version: 1 })).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
    await as('ownerA').post(`/api/v1/documents/${id}/versions/1/restore`).expect(200);
    expect(await DocumentIngestionJob.findOne({ document: id, version: 3 })).toMatchObject({ status: 'queued', source: 'restore' });
  });

  test('trashing removes queued work and chunks; restoring from the trash brings the job back', async () => {
    const id = (await upload('ownerA', 't.txt', 'trash me').expect(201)).body.document.id;
    await DocumentChunk.create(chunkRow({ _id: id, organization: orgA._id }, 1, 0));
    await as('ownerA').delete(`/api/v1/documents/${id}`).expect(200);
    expect(await DocumentIngestionJob.findOne({ document: id })).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
    expect(await DocumentChunk.countDocuments({ document: id })).toBe(0);
    expect(await claim()).toBeNull(); // a trashed document is never processed
    await as('ownerA').post(`/api/v1/documents/${id}/restore`).expect(200);
    expect(await DocumentIngestionJob.findOne({ document: id })).toMatchObject({ status: 'queued', reason: null });
    expect(await DocumentIngestionJob.countDocuments({ document: id })).toBe(1);
  });

  test('permanent deletion removes jobs and chunks entirely', async () => {
    const id = (await upload('adminA', 'p.txt', 'purge me').expect(201)).body.document.id;
    await DocumentChunk.create(chunkRow({ _id: id, organization: orgA._id }, 1, 0));
    expect(await DocumentIngestionJob.countDocuments({ document: id })).toBe(1);
    await as('adminA').delete(`/api/v1/documents/${id}`).expect(200);
    await as('adminA').delete(`/api/v1/documents/${id}/permanent`).expect(200);
    expect(await Document.countDocuments({ _id: id })).toBe(0);
    expect(await DocumentIngestionJob.countDocuments({ document: id })).toBe(0);
    expect(await DocumentChunk.countDocuments({ document: id })).toBe(0);
  });

  test('a failure inside ingestion never fails the user\'s upload', async () => {
    const spy = jest.spyOn(DocumentIngestionJob, 'updateOne').mockRejectedValue(new Error('mongo down PRIVATE-NAME'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await upload('ownerA', 'resilient.txt', 'still uploads').expect(201);
      expect(errors.mock.calls.flat().join(' ')).not.toContain('PRIVATE-NAME'); // the error NAME is logged, never its message
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    expect(await Document.countDocuments({ name: 'resilient.txt' })).toBe(1);
    expect((await reconcile.reconcileOrganization({ organization: orgA._id })).enqueued).toBe(1); // the sweep repairs the gap
  });
});
