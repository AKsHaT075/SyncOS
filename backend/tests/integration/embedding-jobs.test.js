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
 * Embedding spaces, the job state machine, lifecycle (versions, trash, delete), reconciliation and migration.
 * MongoDB + Redis are real; the vector database is not involved (Node never talks to it).
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createIndexedDocument, createStoredDocument, ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const EmbeddingJob = require('../../src/models/EmbeddingJob');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const embedding = require('../../src/services/ai/embedding');
const jobs = require('../../src/services/ai/embedding/embeddingJobs.service');
const reconcile = require('../../src/services/ai/embedding/embeddingReconcile.service');
const spaces = require('../../src/services/ai/embedding/embeddingSpaces.service');
const ingestionJobs = require('../../src/services/ai/ingestion/ingestionJobs.service');
const ingestionApi = require('../../src/services/ai/ingestion/ingestionWorkerApi.service');
const ingestion = require('../../src/services/ai/ingestion');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const FAKE = describeSpace('fake-hash-384');
const E5 = describeSpace('multilingual-e5-small');
const saved = {};
let orgA; let orgB; let orgC;

const indexed = (over = {}) => createIndexedDocument({ organization: orgA, owner: users.ownerA, ...over });
const rowOf = (doc, version = 1, spaceId = FAKE.id, kind = 'embed') => EmbeddingJob.findOne({ document: doc._id, kind, ...(kind === 'embed' ? { version } : {}), spaceId }).select('+lockToken');
const claim = (spaceId = FAKE.id, workerId = 'w') => jobs.claim({ workerId, spaceId, ingestionPipeline: 'p2' });
const expire = (j) => EmbeddingJob.updateOne({ _id: j._id }, { lockExpiresAt: new Date(Date.now() - 1000) });
const due = (j) => EmbeddingJob.updateOne({ _id: j._id }, { nextRunAt: new Date(Date.now() - 1000) });
const redis = () => createRedisClient();
const enqueue = (doc, over = {}) => jobs.enqueueEmbed({ organization: doc.organization, document: doc._id, version: doc.currentVersion, spaceId: FAKE.id, ...over });
const complete = async (job, extra = {}) => {
  const chunks = await DocumentChunk.find({ organization: job.organization, document: job.document, version: job.version }).sort({ chunkIndex: 1 }).lean();
  await EmbeddingJob.updateOne({ _id: job._id }, { status: 'completed', chunkCount: chunks.length, digest: spaces.digestOf(chunks.map((c) => c.textHash)), embeddedAt: new Date(), lastVerifiedAt: new Date(), finishedAt: new Date(), ...extra });
};

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(['ownerA', 'adminA', 'superadmin'].map(makeAgent));
  for (const k of ['AI_EMBEDDING_SPACE', 'AI_EMBEDDING_MAX_ATTEMPTS', 'AI_EMBEDDING_LEASE_SECONDS', 'AI_EMBEDDING_MAX_PROCESSING_SECONDS', 'AI_EMBEDDING_BACKOFF_BASE_SECONDS', 'AI_EMBEDDING_BACKOFF_MAX_SECONDS', 'AI_EMBEDDING_VERIFY_DAYS', 'AI_EMBEDDING_RETIRE_GRACE_HOURS']) saved[k] = env[k];
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
  Object.assign(env, saved);
  env.AI_EMBEDDING_SPACE = 'fake-hash-384';
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  orgC = await Organization.create({ name: 'NoAI', slug: `noai-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'ownerA', ROLES.EMPLOYEE);
  await createUser(orgA, 'adminA', ROLES.ORG_ADMIN);
  await createUser(orgB, 'ownerB', ROLES.EMPLOYEE);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
});

describe('embedding spaces: configuration and migration pointers', () => {
  test('first run: nothing is active yet and the configured space becomes the target', async () => {
    const cfg = await spaces.ensureConfig();
    expect(cfg).toMatchObject({ activeSpaceId: null, targetSpaceId: FAKE.id });
    expect(cfg.spaces[FAKE.id]).toEqual(FAKE.descriptor);
    expect(await spaces.activeSpaceIds()).toEqual([FAKE.id]);
  });

  test('is idempotent and safe under concurrent callers', async () => {
    await Promise.all(Array.from({ length: 25 }, () => spaces.ensureConfig()));
    expect(await AiEmbeddingConfig.countDocuments()).toBe(1);
    expect(await spaces.activeSpaceIds()).toEqual([FAKE.id]);
  });

  test('an unknown configured space is a configuration error, not a silent default', async () => {
    env.AI_EMBEDDING_SPACE = 'does-not-exist';
    await expect(spaces.ensureConfig()).rejects.toMatchObject({ code: 'EMBEDDING_CONFIG' });
  });

  test('a changed model starts a migration; the active space is NOT touched', async () => {
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: FAKE.id, spaces: { [FAKE.id]: FAKE.descriptor } });
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    const cfg = await spaces.ensureConfig();
    expect(cfg).toMatchObject({ activeSpaceId: FAKE.id, targetSpaceId: E5.id });
    expect(await spaces.activeSpaceIds()).toEqual([FAKE.id, E5.id]); // both are served/built during a migration
    expect(cfg.history.map((h) => h.action)).toContain('migration_started');
  });

  test('when configuration matches the active space no migration is pending', async () => {
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: FAKE.id, targetSpaceId: E5.id, spaces: {} });
    await spaces.ensureConfig(); // configured == FAKE == active
    expect((await spaces.getConfig()).targetSpaceId).toBeNull();
  });
});

describe('enqueue: duplicate prevention', () => {
  test('one embed job per (org, document, version, pipeline, space) - sequentially and under a race', async () => {
    const { doc } = await indexed();
    expect((await enqueue(doc)).created).toBe(true);
    expect((await enqueue(doc)).created).toBe(false);
    const fresh = (await indexed()).doc;
    const race = await Promise.all(Array.from({ length: 30 }, () => enqueue(fresh)));
    expect(race.filter((r) => r.created)).toHaveLength(1);
    expect(await EmbeddingJob.countDocuments({ document: fresh._id })).toBe(1);
  });

  test('every space being served or built gets its own job (and only those)', async () => {
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: FAKE.id, spaces: { [FAKE.id]: FAKE.descriptor } });
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    const { doc } = await indexed();
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: doc._id, version: 1 });
    expect((await EmbeddingJob.find({ document: doc._id })).map((j) => j.spaceId).sort()).toEqual([FAKE.id, E5.id].sort());
  });

  test('organizations without AI get nothing', async () => {
    const { doc } = await createIndexedDocument({ organization: orgC, owner: users.ownerA });
    expect(await jobs.enqueueEmbedAllSpaces({ organization: orgC._id, document: doc._id, version: 1 })).toEqual([]);
    expect(await EmbeddingJob.countDocuments()).toBe(0);
  });

  test('a purge request is one row per (document, space); re-asking bumps the generation', async () => {
    const { doc } = await indexed();
    const args = { organization: orgA._id, document: doc._id, spaceId: FAKE.id };
    await jobs.enqueuePurge({ ...args, keepVersion: 2 });
    await Promise.all(Array.from({ length: 10 }, () => jobs.enqueuePurge({ ...args, keepVersion: 3 })));
    const rows = await EmbeddingJob.find({ document: doc._id, kind: 'purge' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keepVersion: 3, status: 'queued', generation: 11 });
  });
});

describe('claim', () => {
  test('is atomic: 30 workers over 10 jobs claim each job exactly once', async () => {
    for (let i = 0; i < 10; i += 1) await enqueue((await indexed()).doc);
    const got = (await Promise.all(Array.from({ length: 30 }, (_, i) => claim(FAKE.id, `w${i}`)))).filter(Boolean);
    expect(got).toHaveLength(10);
    expect(new Set(got.map((j) => j._id.toString())).size).toBe(10);
    expect(new Set(got.map((j) => j.lockToken)).size).toBe(10);
    expect((await EmbeddingJob.find({})).every((j) => j.status === 'processing' && j.attempts === 1)).toBe(true);
  });

  test('a worker only receives jobs of the space it produces, for the pipeline it runs', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    expect(await claim(E5.id)).toBeNull();
    expect(await jobs.claim({ workerId: 'w', spaceId: FAKE.id, ingestionPipeline: 'p1' })).toBeNull();
    expect(await jobs.claim({ workerId: 'w', spaceId: 123, ingestionPipeline: 'p2' })).toBeNull();
    expect(await claim()).toMatchObject({ kind: 'embed', chunkCount: 3 });
  });

  test('purges are handed out before embeds', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await jobs.enqueuePurge({ organization: orgA._id, document: oid(), spaceId: FAKE.id });
    expect((await claim()).kind).toBe('purge');
    expect((await claim()).kind).toBe('embed');
  });

  test.each([
    ['trashed', async (d) => Document.updateOne({ _id: d._id }, { deletedAt: new Date() }), 'DOCUMENT_DELETED'],
    ['superseded by a new version', async (d) => Document.updateOne({ _id: d._id }, { currentVersion: 2 }), 'SUPERSEDED'],
    ['extraction not indexed', async (d) => DocumentIngestionJob.updateOne({ document: d._id }, { status: 'failed' }), 'INGESTION_NOT_INDEXED'],
    ['no chunks', async (d) => DocumentChunk.deleteMany({ document: d._id }), 'NO_CHUNKS'],
  ])('a job for a %s document is never handed out', async (_n, mutate, reason) => {
    const { doc } = await indexed();
    await enqueue(doc);
    await mutate(doc);
    expect(await claim()).toBeNull();
    expect(await rowOf(doc)).toMatchObject({ status: 'skipped', reason });
  });

  test('an organization that switched AI off keeps its jobs queued, uncounted', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    expect(await claim()).toBeNull();
    const row = await rowOf(doc);
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('a space that is no longer served is retired, not embedded', async () => {
    const { doc } = await indexed();
    await enqueue(doc, { spaceId: E5.id }); // E5 is neither active nor target
    expect(await claim(E5.id)).toBeNull();
    expect(await rowOf(doc, 1, E5.id)).toMatchObject({ status: 'skipped', reason: 'SPACE_RETIRED' });
  });

  test('a chunk set from a different ingestion pipeline is not used', async () => {
    const { doc } = await indexed();
    await DocumentChunk.updateMany({ document: doc._id }, { pipelineVersion: 'p1' });
    await enqueue(doc);
    expect(await claim()).toBeNull();
    expect(await rowOf(doc)).toMatchObject({ status: 'skipped', reason: 'NO_CHUNKS' });
  });
});

describe('lease, heartbeat and crashed workers', () => {
  test('heartbeat extends the lease; a wrong token or expired lease cannot', async () => {
    await enqueue((await indexed()).doc);
    const j = await claim();
    await EmbeddingJob.updateOne({ _id: j._id }, { lockExpiresAt: new Date(Date.now() + 5000) });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toEqual({ ok: true });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: 'x'.repeat(48) })).toMatchObject({ ok: false, reason: 'LOCK_LOST' });
    await expire(j);
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false });
  });

  test('a document trashed mid-job is discovered at the next heartbeat and its vectors are queued for removal', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const j = await claim();
    await Document.updateOne({ _id: doc._id }, { deletedAt: new Date() });
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false, reason: 'DOCUMENT_DELETED' });
    expect(await rowOf(doc)).toMatchObject({ status: 'skipped', reason: 'DOCUMENT_DELETED' });
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ status: 'queued', keepVersion: null });
  });

  test('a version superseded mid-job queues a purge that keeps only the current version', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const j = await claim();
    await addVersion(doc, Buffer.from('a newer version'));
    expect(await jobs.heartbeat({ jobId: j._id, lockToken: j.lockToken })).toMatchObject({ ok: false, reason: 'SUPERSEDED' });
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ keepVersion: 2 });
  });

  test('a crashed worker: lease lapses -> failed with backoff -> claimed again with a new token', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const first = await claim(FAKE.id, 'crashy');
    await expire(first);
    expect(await jobs.recoverStale()).toEqual({ dead: 0, retried: 1 });
    const failed = await rowOf(doc);
    expect(failed).toMatchObject({ status: 'failed', reason: 'LOCK_EXPIRED', attempts: 1 });
    expect(await claim()).toBeNull();
    await due(failed);
    const second = await claim(FAKE.id, 'healthy');
    expect(second).toMatchObject({ attempts: 2, lockedBy: 'healthy' });
    expect(second.lockToken).not.toBe(first.lockToken);
  });

  test('a job that keeps killing workers goes dead; recovery is concurrent-safe', async () => {
    env.AI_EMBEDDING_MAX_ATTEMPTS = 2;
    const { doc } = await indexed();
    await enqueue(doc);
    await EmbeddingJob.updateOne({ document: doc._id }, { maxAttempts: 2 });
    for (let a = 1; a <= 2; a += 1) {
      const j = await claim();
      await expire(j);
      await Promise.all([jobs.recoverStale(), jobs.recoverStale(), jobs.recoverStale()]);
      if (a < 2) await due(await rowOf(doc));
    }
    expect(await rowOf(doc)).toMatchObject({ status: 'dead', reason: 'LOCK_EXPIRED', attempts: 2 });
    expect(await claim()).toBeNull();
  });

  test('a zombie holding an old lock token cannot fail, skip or overwrite the new owner', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const stale = await claim(FAKE.id, 'slow');
    await expire(stale);
    await jobs.recoverStale();
    await due(await rowOf(doc));
    await claim(FAKE.id, 'fast');
    expect(await jobs.failJob({ job: stale, reason: 'INTERNAL_ERROR' })).toBeNull();
    expect(await jobs.skipJob({ job: stale, reason: 'NO_CHUNKS' })).toBeNull();
    expect(await rowOf(doc)).toMatchObject({ status: 'processing', lockedBy: 'fast' });
  });
});

describe('retry, backoff, dead letter, administrator retry', () => {
  test('backoff grows exponentially (with jitter) up to the cap', () => {
    env.AI_EMBEDDING_BACKOFF_BASE_SECONDS = 30;
    env.AI_EMBEDDING_BACKOFF_MAX_SECONDS = 1800;
    for (const [attempt, nominal] of [[1, 30], [2, 60], [4, 240], [9, 1800]]) {
      for (let i = 0; i < 20; i += 1) {
        const ms = jobs.backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual((nominal * 1000) / 2);
        expect(ms).toBeLessThanOrEqual(nominal * 1000);
      }
    }
  });

  test('transient failures retry, then die; an administrator can revive a dead job', async () => {
    env.AI_EMBEDDING_MAX_ATTEMPTS = 2;
    const { doc } = await indexed();
    await enqueue(doc);
    await EmbeddingJob.updateOne({ document: doc._id }, { maxAttempts: 2 });
    let after = await jobs.failJob({ job: await claim(), reason: 'VECTOR_STORE_UNAVAILABLE' });
    expect(after).toMatchObject({ status: 'failed', reason: 'VECTOR_STORE_UNAVAILABLE' });
    await due(after);
    after = await jobs.failJob({ job: await claim(), reason: 'VECTOR_STORE_UNAVAILABLE' });
    expect(after).toMatchObject({ status: 'dead' });
    const retried = await jobs.retryJob({ organization: orgA._id, jobId: after._id });
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, source: 'admin' });
    expect(await claim()).toMatchObject({ attempts: 1 });
  });

  test('retry is refused for running, completed, superseded or retired work, and is invisible across organizations', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    const queued = await rowOf(doc);
    await expect(jobs.retryJob({ organization: orgA._id, jobId: queued._id })).rejects.toMatchObject({ statusCode: 409 });
    const j = await claim();
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 409 });
    await complete(j);
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 409 });
    await EmbeddingJob.updateOne({ _id: j._id }, { status: 'dead' });
    await addVersion(doc, Buffer.from('v2 bytes'));
    await expect(jobs.retryJob({ organization: orgA._id, jobId: j._id })).rejects.toMatchObject({ code: 'EMBEDDING_NOT_RETRYABLE' });
    await expect(jobs.retryJob({ organization: orgB._id, jobId: j._id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(jobs.retryJob({ organization: orgB._id, jobId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('document lifecycle', () => {
  test('finishing extraction (ingestion indexed) queues the embedding for every served space', async () => {
    const doc = await createStoredDocument({ organization: orgA, owner: users.ownerA });
    await ingestionJobs.enqueue({ organization: orgA._id, document: doc._id, version: 1, extension: 'txt', size: doc.size, checksum: doc.checksum });
    const job = await ingestionJobs.claim({ workerId: 'ing', pipelineVersion: 'p2' });
    const text = 'Annual leave is 24 days.';
    const crypto = require('crypto');
    await ingestionApi.submitResult({
      jobId: job._id,
      lockToken: job.lockToken,
      result: { status: 'indexed', format: 'txt', pipelineVersion: 'p2', stats: {}, chunks: [{ index: 0, text, textHash: crypto.createHash('sha256').update(text).digest('hex'), tokenEstimate: 6, location: {} }] },
    });
    expect(await rowOf(doc)).toMatchObject({ status: 'queued', kind: 'embed', ingestionPipeline: 'p2' });
  });

  test('a failure while queueing the embedding never breaks extraction', async () => {
    const spy = jest.spyOn(EmbeddingJob, 'updateOne').mockRejectedValue(new Error('mongo down PRIVATE-NAME'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await embedding.documentIndexed(orgA._id, oid(), 1)).toBeNull();
      expect(errors.mock.calls.flat().join(' ')).not.toContain('PRIVATE-NAME');
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });

  test('trashing marks embeddings skipped and asks for the vectors to be removed from EVERY space', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await enqueue(doc, { spaceId: E5.id });
    await complete(await rowOf(doc));
    await ingestion.documentsTrashed(orgA._id, [doc._id]);
    expect((await EmbeddingJob.find({ document: doc._id, kind: 'embed' })).every((r) => r.status === 'skipped' && r.reason === 'DOCUMENT_DELETED')).toBe(true);
    expect((await EmbeddingJob.find({ document: doc._id, kind: 'purge' })).map((r) => r.spaceId).sort()).toEqual([FAKE.id, E5.id].sort());
  });

  test('restoring from the trash re-embeds (the skipped row is revived once extraction is indexed again)', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    await ingestion.documentsTrashed(orgA._id, [doc._id]);
    await embedding.documentIndexed(orgA._id, doc._id, 1);
    expect(await rowOf(doc)).toMatchObject({ status: 'queued', reason: null });
    expect(await EmbeddingJob.countDocuments({ document: doc._id, kind: 'embed' })).toBe(1);
  });

  test('permanent deletion keeps the purge request until the vectors are really gone, then leaves nothing behind', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    await Document.deleteOne({ _id: doc._id });
    await ingestion.documentsPurged(orgA._id, [doc._id]);
    const purge = await rowOf(doc, 0, FAKE.id, 'purge');
    expect(purge).toMatchObject({ status: 'queued' });
    expect(await EmbeddingJob.countDocuments({ document: doc._id })).toBe(2); // embed row (skipped) + purge row survive
    const api = require('../../src/services/ai/embedding/embeddingWorkerApi.service');
    const claimed = await claim();
    expect(claimed.kind).toBe('purge');
    await api.submitResult({ jobId: claimed._id, lockToken: claimed.lockToken, result: { status: 'completed', deleted: 3, generation: claimed.generation } });
    expect(await EmbeddingJob.countDocuments({ document: doc._id })).toBe(0);
  });

  test('a new version, once embedded, supersedes the older ones and queues their removal', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    const v2 = await addVersion(doc, Buffer.from('second version'));
    await createIndexedDocument({ organization: orgA, owner: users.ownerA, doc: v2, version: 2, chunks: 2 });
    await DocumentIngestionJob.updateOne({ document: doc._id, version: 1 }, { status: 'skipped', reason: 'SUPERSEDED' });
    await enqueue(v2);
    const api = require('../../src/services/ai/embedding/embeddingWorkerApi.service');
    const j = await claim();
    expect(j.version).toBe(2);
    const chunks = await DocumentChunk.find({ document: doc._id, version: 2 }).sort({ chunkIndex: 1 }).lean();
    await api.submitResult({ jobId: j._id, lockToken: j.lockToken, result: { status: 'embedded', spaceId: FAKE.id, model: FAKE.descriptor.model, revision: FAKE.descriptor.revision, dimensions: 384, count: 2, digest: spaces.digestOf(chunks.map((c) => c.textHash)) } });
    expect(await rowOf(doc, 1)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });
    expect(await rowOf(doc, 2)).toMatchObject({ status: 'completed' });
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ keepVersion: 2, status: 'queued' });
  });
});

describe('reconciliation', () => {
  test('back-fills extracted documents that have no embedding job (e.g. extracted before the space existed)', async () => {
    const a = (await indexed()).doc;
    const b = (await indexed()).doc;
    const r = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r).toMatchObject({ examined: 2, enqueued: 2 });
    expect([await rowOf(a), await rowOf(b)].every((x) => x.status === 'queued' && x.source === 'reconcile')).toBe(true);
    expect((await reconcile.reconcileOrganization({ organization: orgA._id })).enqueued).toBe(0); // idempotent
  });

  test('does not embed documents that are not extracted, trashed, in AI-off orgs, or in other orgs', async () => {
    const pending = await createStoredDocument({ organization: orgA, owner: users.ownerA });
    await DocumentIngestionJob.create({ organization: orgA._id, document: pending._id, version: 1, pipelineVersion: 'p2', checksum: pending.checksum, status: 'processing' });
    const trashed = (await indexed()).doc;
    await Document.updateOne({ _id: trashed._id }, { deletedAt: new Date() });
    await createIndexedDocument({ organization: orgC, owner: users.ownerA });
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await reconcile.reconcileOrganization({ organization: orgC._id })).toMatchObject({ skipped: 'AI_DISABLED' });
    expect(await EmbeddingJob.countDocuments({ kind: 'embed' })).toBe(0);
  });

  test('fills a NEW space for existing documents during a migration while the old space keeps its jobs', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: FAKE.id, spaces: { [FAKE.id]: FAKE.descriptor } });
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await rowOf(doc, 1, FAKE.id)).toMatchObject({ status: 'completed' }); // untouched
    expect(await rowOf(doc, 1, E5.id)).toMatchObject({ status: 'queued' });
  });

  test('purges vectors of old versions once the current one is settled, and of trashed documents', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    const v2 = await addVersion(doc, Buffer.from('v2'));
    await createIndexedDocument({ organization: orgA, owner: users.ownerA, doc: v2, version: 2, chunks: 1 });
    await enqueue(v2);
    await complete(await rowOf(v2, 2));
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ keepVersion: 2 });
    expect(await rowOf(doc, 1)).toMatchObject({ status: 'skipped', reason: 'SUPERSEDED' });

    const gone = (await indexed()).doc;
    await enqueue(gone);
    await complete(await rowOf(gone));
    await Document.updateOne({ _id: gone._id }, { deletedAt: new Date() }); // e.g. a folder was trashed: no per-document hook ran
    const r = await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await rowOf(gone, 0, FAKE.id, 'purge')).toMatchObject({ keepVersion: null });
  });

  test('purges vectors of a version whose successor could not be extracted (stale content must not stay searchable)', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    const v2 = await addVersion(doc, Buffer.from('encrypted something'));
    await DocumentIngestionJob.create({ organization: orgA._id, document: doc._id, version: 2, pipelineVersion: 'p2', checksum: v2.checksum, status: 'skipped', reason: 'ENCRYPTED' });
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ keepVersion: 2 });
  });

  test('orphans: embedding rows whose document no longer exists get their vectors purged', async () => {
    const { doc } = await indexed();
    await enqueue(doc);
    await complete(await rowOf(doc));
    await Document.deleteOne({ _id: doc._id }); // crash between deleting the document and requesting the purge
    expect(await reconcile.reconcileOrphans(orgA._id)).toBe(1);
    expect(await rowOf(doc, 0, FAKE.id, 'purge')).toMatchObject({ status: 'queued' });
  });

  test('periodic verification re-queues the oldest completed jobs; force re-queues all of an org', async () => {
    env.AI_EMBEDDING_VERIFY_DAYS = 7;
    const old = (await indexed()).doc;
    const fresh = (await indexed()).doc;
    for (const d of [old, fresh]) {
      await enqueue(d);
      await complete(await rowOf(d));
    }
    await EmbeddingJob.updateOne({ document: old._id }, { lastVerifiedAt: new Date(Date.now() - 8 * 86400 * 1000) });
    expect(await reconcile.requeueVerification()).toBe(1);
    expect(await rowOf(old)).toMatchObject({ status: 'queued', source: 'verify' });
    expect(await rowOf(fresh)).toMatchObject({ status: 'completed' });
    expect(await reconcile.requeueVerification({ organization: orgA._id, force: true })).toBe(1);
    expect(await reconcile.requeueVerification({ organization: orgB._id, force: true })).toBe(0); // another tenant's rows are untouched
  });

  test('sweepAll covers AI-enabled organizations only', async () => {
    await indexed();
    await createIndexedDocument({ organization: orgB, owner: users.ownerB });
    await createIndexedDocument({ organization: orgC, owner: users.ownerA });
    const totals = await reconcile.sweepAll();
    expect(totals).toMatchObject({ organizations: 2, enqueued: 2 });
    expect(await EmbeddingJob.countDocuments({ organization: orgC._id })).toBe(0);
  });
});

describe('model migration: atomic from the application\'s point of view', () => {
  async function startMigration() {
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: FAKE.id, spaces: { [FAKE.id]: FAKE.descriptor } });
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    await spaces.ensureConfig();
  }
  async function embeddedIn(spaceIds, doc) {
    for (const spaceId of spaceIds) {
      await enqueue(doc, { spaceId });
      await complete(await rowOf(doc, 1, spaceId));
    }
  }

  test('promotion is refused until the new space covers every eligible document', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    const b = (await indexed()).doc;
    await embeddedIn([FAKE.id, E5.id], a);
    await embeddedIn([FAKE.id], b);
    await enqueue(b, { spaceId: E5.id });
    await expect(spaces.promote()).rejects.toMatchObject({ code: 'EMBEDDING_MIGRATION_NOT_READY', details: { problems: expect.arrayContaining(['INCOMPLETE_COVERAGE', 'JOBS_PENDING']) } });
    expect(await spaces.getConfig()).toMatchObject({ activeSpaceId: FAKE.id, targetSpaceId: E5.id }); // nothing moved
  });

  test('a dead job in the new space blocks promotion; the active space stays fully usable', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    await embeddedIn([FAKE.id], a);
    await enqueue(a, { spaceId: E5.id });
    await EmbeddingJob.updateOne({ document: a._id, spaceId: E5.id }, { status: 'dead', reason: 'EMBEDDING_UNAVAILABLE' });
    await expect(spaces.promote()).rejects.toMatchObject({ details: { problems: expect.arrayContaining(['DEAD_JOBS']) } });
    expect((await spaces.getConfig()).activeSpaceId).toBe(FAKE.id);
    expect(await rowOf(a, 1, FAKE.id)).toMatchObject({ status: 'completed' }); // the previous index is untouched
  });

  test('a digest that no longer matches the chunks Node holds blocks promotion', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    await embeddedIn([FAKE.id, E5.id], a);
    await EmbeddingJob.updateOne({ document: a._id, spaceId: E5.id }, { digest: 'f'.repeat(64) });
    await expect(spaces.promote()).rejects.toMatchObject({ details: { problems: expect.arrayContaining(['DIGEST_MISMATCH']) } });
  });

  test('a complete, verified target is promoted in one step; the old space is retired later, not immediately', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    const b = (await indexed()).doc;
    for (const d of [a, b]) await embeddedIn([FAKE.id, E5.id], d);
    const { config, coverage } = await spaces.promote();
    expect(coverage).toMatchObject({ eligible: 2, embedded: 2 });
    expect(config).toMatchObject({ activeSpaceId: E5.id, targetSpaceId: null, retiringSpaceId: FAKE.id });
    expect(config.retireAfter.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    expect(await spaces.activeSpaceIds()).toEqual([E5.id]); // new documents now go to the new space only
    expect(await reconcile.retireOldSpace()).toEqual({ retired: 0 }); // grace period not over: the old vectors are still there
    expect(await rowOf(a, 1, FAKE.id)).toMatchObject({ status: 'completed' });
  });

  test('after the grace period the previous space is purged and forgotten', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    await embeddedIn([FAKE.id, E5.id], a);
    await spaces.promote();
    await AiEmbeddingConfig.updateOne({ _id: 'embedding' }, { retireAfter: new Date(Date.now() - 1000) });
    const first = await reconcile.retireOldSpace();
    expect(first.retired).toBe(1);
    expect(await rowOf(a, 0, FAKE.id, 'purge')).toMatchObject({ status: 'queued', keepVersion: null });
    expect((await spaces.getConfig()).retiringSpaceId).toBe(FAKE.id); // not forgotten until the purge actually finished
    const api = require('../../src/services/ai/embedding/embeddingWorkerApi.service');
    const p = await claim(FAKE.id);
    await api.submitResult({ jobId: p._id, lockToken: p.lockToken, result: { status: 'completed', deleted: 3, generation: p.generation } });
    await reconcile.retireOldSpace();
    expect((await spaces.getConfig()).retiringSpaceId).toBeNull();
    expect(await EmbeddingJob.countDocuments({ spaceId: FAKE.id })).toBe(0);
  });

  test('two concurrent promotions: exactly one wins, nothing is switched twice', async () => {
    await startMigration();
    await embeddedIn([FAKE.id, E5.id], (await indexed()).doc);
    const results = await Promise.allSettled([spaces.promote(), spaces.promote(), spaces.promote()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await spaces.getConfig()).toMatchObject({ activeSpaceId: E5.id, retiringSpaceId: FAKE.id });
    expect((await spaces.getConfig()).history.filter((h) => h.action === 'promoted')).toHaveLength(1);
  });

  test('a configuration change racing a promotion switches nothing', async () => {
    await startMigration();
    await embeddedIn([FAKE.id, E5.id], (await indexed()).doc);
    const realFind = AiEmbeddingConfig.findOneAndUpdate.bind(AiEmbeddingConfig);
    jest.spyOn(AiEmbeddingConfig, 'findOneAndUpdate').mockImplementationOnce(async (filter, ...rest) => {
      await AiEmbeddingConfig.updateOne({ _id: 'embedding' }, { $inc: { revision: 1 } }); // someone else touched the pointer first
      return realFind(filter, ...rest);
    });
    await expect(spaces.promote()).rejects.toMatchObject({ code: 'EMBEDDING_CONFIG_CHANGED' });
    expect((await spaces.getConfig()).activeSpaceId).toBe(FAKE.id);
  });

  test('abandoning stops the build, keeps the active space, and blocks an automatic restart', async () => {
    await startMigration();
    expect((await spaces.abandonMigration()).abandoned).toBe(E5.id);
    expect(await spaces.getConfig()).toMatchObject({ activeSpaceId: FAKE.id, targetSpaceId: null, blockedSpaceId: E5.id });
    await spaces.ensureConfig(); // configuration still says e5, but the administrator said stop
    expect((await spaces.getConfig()).targetSpaceId).toBeNull();
    await spaces.unblockAndStart();
    expect((await spaces.getConfig()).targetSpaceId).toBe(E5.id);
    await expect(spaces.abandonMigration()).resolves.toBeTruthy();
    await expect(spaces.abandonMigration()).rejects.toMatchObject({ code: 'EMBEDDING_NO_MIGRATION' });
  });

  test('coverage counts only live, extracted documents of AI-enabled organizations (per tenant when scoped)', async () => {
    await startMigration();
    const a = (await indexed()).doc;
    const b = (await createIndexedDocument({ organization: orgB, owner: users.ownerB })).doc;
    const trashed = (await indexed()).doc;
    await Document.updateOne({ _id: trashed._id }, { deletedAt: new Date() });
    await createIndexedDocument({ organization: orgC, owner: users.ownerA });
    await embeddedIn([E5.id], a);
    expect(await spaces.coverage(E5.id)).toMatchObject({ eligible: 2, embedded: 1 });
    expect(await spaces.coverage(E5.id, orgA._id)).toMatchObject({ eligible: 1, embedded: 1 });
    expect(await spaces.coverage(E5.id, orgB._id)).toMatchObject({ eligible: 1, embedded: 0 });
    void b;
  });
});
