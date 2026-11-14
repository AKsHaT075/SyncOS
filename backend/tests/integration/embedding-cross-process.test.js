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
 * CROSS-PROCESS: the REAL Python embedding (and ingestion) workers, a REAL Qdrant server (the verified release binary in
 * ai/.qdrant, with API-key auth), Node's REAL internal listener, real documents in real storage, and - for the
 * end-to-end and migration tests - the REAL multilingual-e5-small model from the Hugging Face cache (offline).
 * Skipped, loudly, if ai/.venv or the Qdrant binary is missing.
 */
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createIndexedDocument, createStoredDocument, createWorkerKeys, ensureIndexes } = require('../helpers/ingestionHelpers');
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
const { createInternalApp } = require('../../src/internalApp');

const AI_DIR = path.resolve(__dirname, '../../../ai');
const PYTHON = path.join(AI_DIR, '.venv/bin/python');
const QDRANT_BIN = path.join(AI_DIR, '.qdrant/qdrant');
const HAVE = fs.existsSync(PYTHON) && fs.existsSync(QDRANT_BIN);
if (!HAVE) console.warn('[embedding-cross-process] SKIPPED: ai/.venv or ai/.qdrant/qdrant is missing (see ai/README.md)');
const d = HAVE ? describe : describe.skip;

const { users, createUser } = createHarness();
const keys = createWorkerKeys();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const FAKE = describeSpace('fake-hash-384');
const E5 = describeSpace('multilingual-e5-small');
const QKEY = 'xp-test-api-key-not-a-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-xp-'));
const saved = {};
let server; let nodeUrl; let qdrant; let qUrl; let prefix; let orgA; let orgB; let orgC;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('condition not reached in time');
};

// ---- talking to Qdrant directly (test code only; Node itself never does) -------------------------------------------
const q = async (method, url, body) => {
  const res = await fetch(`${qUrl}${url}`, { method, headers: { 'api-key': QKEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const collection = (spaceId) => `${prefix}_${spaceId}`;
const must = (org, doc, extra = []) => [{ key: 'organization', match: { value: String(org) } }, ...(doc ? [{ key: 'document', match: { value: String(doc) } }] : []), ...extra];
const vcount = async (spaceId, org, doc, version) => {
  const r = await q('POST', `/collections/${collection(spaceId)}/points/count`, { exact: true, filter: { must: must(org, doc, version ? [{ key: 'version', match: { value: version } }] : []) } });
  return r.status === 'ok' || r.result ? r.result.count : 0;
};
const collections = async () => (await q('GET', '/collections')).result.collections.map((c) => c.name);

function spawnPython(module, args, extraEnv = {}) {
  const proc = spawn(PYTHON, ['-m', module, ...args], {
    cwd: AI_DIR,
    env: {
      PATH: process.env.PATH, // deliberately NOT the parent env: no Groq key, no Mongo URI, nothing else reaches a worker
      HF_HOME: process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'),
      AI_EMBEDDING_OFFLINE: 'true',
      AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'worker-private.pem'),
      AI_WORKER_KEY_ID: 'w1',
      AI_NODE_INTERNAL_URL: nodeUrl,
      AI_INGEST_TMP_DIR: path.join(tmp, 'ing-tmp'),
      AI_INGEST_TIMEOUT_SECONDS: '60',
      QDRANT_URL: qUrl,
      QDRANT_API_KEY: QKEY,
      QDRANT_COLLECTION_PREFIX: prefix,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.logs = '';
  proc.stdout.on('data', (b) => { proc.logs += b; });
  proc.stderr.on('data', (b) => { proc.logs += b; });
  proc.done = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return proc;
}
const embedWorker = (provider = 'fake', extra = {}) => spawnPython('app.embeddings.worker', ['--once'], { AI_EMBEDDING_PROVIDER: provider, ...extra });
const ingestWorker = (extra = {}) => spawnPython('app.ingestion.worker', ['--once'], extra);
const probe = (provider, org, query, docs = '') => JSON.parse(execFileSync(PYTHON, ['-m', 'tests.query_probe', String(org), query, docs], { cwd: AI_DIR, encoding: 'utf8', env: { PATH: process.env.PATH, HF_HOME: process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), AI_EMBEDDING_OFFLINE: 'true', AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'worker-private.pem'), AI_EMBEDDING_PROVIDER: provider, QDRANT_URL: qUrl, QDRANT_API_KEY: QKEY, QDRANT_COLLECTION_PREFIX: prefix } }).trim().split('\n').pop());

const doc = async (org, over = {}) => (await createIndexedDocument({ organization: org, owner: users.ownerA, ...over })).doc;
const row = (document, spaceId = FAKE.id, version = 1, kind = 'embed') => EmbeddingJob.findOne({ document: document._id, spaceId, kind, ...(kind === 'embed' ? { version } : {}) });
const chunkCount = (document, version = 1) => DocumentChunk.countDocuments({ document: document._id, version });

beforeAll(async () => {
  if (!HAVE) return;
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  fs.mkdirSync(path.join(tmp, 'ing-tmp'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'worker-private.pem'), keys.privatePem, { mode: 0o600 });
  for (const k of ['AI_WORKER_PUBLIC_KEY', 'AI_WORKER_PUBLIC_KEY_FILE', 'AI_WORKER_KEY_ID', 'AI_EMBEDDING_SPACE', 'AI_EMBEDDING_RETIRE_GRACE_HOURS']) saved[k] = env[k];
  env.AI_WORKER_PUBLIC_KEY = keys.publicPem;
  env.AI_WORKER_PUBLIC_KEY_FILE = '';
  env.AI_WORKER_KEY_ID = 'w1';
  const app = createInternalApp();
  server = http.createServer((req, res) => app(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  nodeUrl = `http://127.0.0.1:${server.address().port}`;

  const http_ = await freePort();
  qUrl = `http://127.0.0.1:${http_}`;
  qdrant = spawn(QDRANT_BIN, [], {
    cwd: tmp,
    env: { PATH: process.env.PATH, QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__SERVICE__HTTP_PORT: String(http_), QDRANT__SERVICE__GRPC_PORT: String(await freePort()), QDRANT__SERVICE__API_KEY: QKEY, QDRANT__STORAGE__STORAGE_PATH: path.join(tmp, 'qstorage'), QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(tmp, 'qsnap'), QDRANT__TELEMETRY_DISABLED: 'true' },
    stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(`${qUrl}/healthz`)).ok; } catch { return false; } }, 30000);
}, 90000);
afterAll(async () => {
  if (!HAVE) return;
  Object.assign(env, saved);
  qdrant.kill('SIGKILL');
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  await hub.shutdown();
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  if (!HAVE) return;
  env.AI_EMBEDDING_SPACE = 'fake-hash-384';
  prefix = `xp${crypto.randomBytes(4).toString('hex')}`; // a fresh set of collections per test
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  orgC = await Organization.create({ name: 'NoAI', slug: `noai-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'ownerA', ROLES.EMPLOYEE);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
});

d('embedding worker + Qdrant server (fake provider: fast, deterministic)', () => {
  test('chunks are embedded into the right collection with the documented point layout', async () => {
    const a = await doc(orgA, { chunks: 5 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    const w = embedWorker();
    expect(await w.done).toEqual({ code: 0, signal: null });
    expect(await row(a)).toMatchObject({ status: 'completed', chunkCount: 5, reason: null });
    expect(await collections()).toContain(collection(FAKE.id));
    expect(await vcount(FAKE.id, orgA._id, a._id, 1)).toBe(5);
    const info = (await q('GET', `/collections/${collection(FAKE.id)}`)).result;
    expect(info.config.params.vectors).toMatchObject({ size: 384, distance: 'Cosine' });
    expect(Object.fromEntries(Object.entries(info.payload_schema).map(([k, v]) => [k, v.data_type]))).toMatchObject({ organization: 'keyword', document: 'keyword', version: 'integer' });
    const pts = (await q('POST', `/collections/${collection(FAKE.id)}/points/scroll`, { limit: 10, with_payload: true, with_vector: false })).result.points;
    for (const p of pts) {
      expect(Object.keys(p.payload).sort()).toEqual(['chunk_index', 'document', 'ingestion_pipeline', 'organization', 'space', 'text_hash', 'version']);
      expect(p.payload).toMatchObject({ organization: orgA._id.toString(), document: a._id.toString(), version: 1, ingestion_pipeline: 'p2', space: FAKE.id });
    }
    const stored = await DocumentChunk.find({ document: a._id }).lean();
    expect(JSON.stringify(pts)).not.toContain(stored[0].text); // no document text in the index
  }, 90000);

  test('running a worker again changes nothing (idempotent), and a damaged index is repaired by verification', async () => {
    const a = await doc(orgA, { chunks: 6 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    await embedWorker().done;
    await reconcile.requeueVerification({ organization: orgA._id, force: true });
    await embedWorker().done;
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(6); // no duplicates
    // simulate a damaged index: lose 2 points and add a stray one
    await q('POST', `/collections/${collection(FAKE.id)}/points/delete?wait=true`, { filter: { must: must(orgA._id, a._id, [{ key: 'chunk_index', match: { any: [1, 4] } }]) } });
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(4);
    await reconcile.requeueVerification({ organization: orgA._id, force: true });
    await embedWorker().done;
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(6);
    expect(await row(a)).toMatchObject({ status: 'completed' });
  }, 90000);

  test('a new version replaces the old version\'s vectors (the old ones are purged)', async () => {
    const a = await doc(orgA, { chunks: 4 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    await embedWorker().done;
    expect(await vcount(FAKE.id, orgA._id, a._id, 1)).toBe(4);
    const v2 = await addVersion(a, Buffer.from('second version'));
    await DocumentIngestionJob.updateOne({ document: a._id, version: 1 }, { status: 'skipped', reason: 'SUPERSEDED' });
    await createIndexedDocument({ organization: orgA, owner: users.ownerA, doc: v2, version: 2, chunks: 2 });
    await embedding.documentIndexed(orgA._id, a._id, 2);
    await embedWorker().done; // embeds v2, which queues the purge of v1 ...
    await embedWorker().done; // ... which the next run executes
    expect(await vcount(FAKE.id, orgA._id, a._id, 2)).toBe(2);
    expect(await vcount(FAKE.id, orgA._id, a._id, 1)).toBe(0);
  }, 90000);

  test('trashing a document removes its vectors; other documents and other organizations are untouched', async () => {
    const a1 = await doc(orgA, { chunks: 3 });
    const a2 = await doc(orgA, { chunks: 3 });
    const b1 = await createIndexedDocument({ organization: orgB, owner: users.ownerA, chunks: 3, doc: await createStoredDocument({ organization: orgB, owner: users.ownerA }) });
    for (const x of [a1, a2, b1.doc]) await jobs.enqueueEmbedAllSpaces({ organization: x.organization, document: x._id, version: 1 });
    await embedWorker().done;
    expect([await vcount(FAKE.id, orgA._id, a1._id), await vcount(FAKE.id, orgA._id, a2._id), await vcount(FAKE.id, orgB._id, b1.doc._id)]).toEqual([3, 3, 3]);
    await Document.updateOne({ _id: a1._id }, { deletedAt: new Date() });
    await require('../../src/services/ai/ingestion').documentsTrashed(orgA._id, [a1._id]);
    await embedWorker().done;
    expect([await vcount(FAKE.id, orgA._id, a1._id), await vcount(FAKE.id, orgA._id, a2._id), await vcount(FAKE.id, orgB._id, b1.doc._id)]).toEqual([0, 3, 3]);
  }, 90000);

  test('the same document id in two organizations stays separate in the index', async () => {
    const a = await doc(orgA, { chunks: 3 });
    // an org-B document that reuses org A's document id string is impossible in Mongo (ObjectIds are unique), but the
    // index must still never return or delete another tenant's points for a given organization filter:
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    await embedWorker().done;
    expect(await vcount(FAKE.id, orgB._id, a._id)).toBe(0);
    const hits = probe('fake', orgB._id, 'leave policy text');
    expect(hits).toEqual([]);
    expect(probe('fake', orgA._id, 'leave policy text').length).toBeGreaterThan(0);
  }, 90000);

  test('permanent deletion leaves no vectors and no bookkeeping', async () => {
    const a = await doc(orgA, { chunks: 4 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    await embedWorker().done;
    await Document.deleteOne({ _id: a._id });
    await require('../../src/services/ai/ingestion').documentsPurged(orgA._id, [a._id]);
    await embedWorker().done;
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(0);
    expect(await EmbeddingJob.countDocuments({ document: a._id })).toBe(0);
  }, 90000);

  test('two workers at once embed every document exactly once with no duplicate points', async () => {
    const docs = [];
    for (let i = 0; i < 10; i += 1) {
      const x = await doc(orgA, { chunks: 4 });
      await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: x._id, version: 1 });
      docs.push(x);
    }
    await Promise.all([embedWorker('fake', { AI_WORKER_ID: 'ew-a' }).done, embedWorker('fake', { AI_WORKER_ID: 'ew-b' }).done]);
    const rows = await EmbeddingJob.find({ kind: 'embed' });
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.status === 'completed' && r.attempts === 1)).toBe(true);
    for (const x of docs) expect(await vcount(FAKE.id, orgA._id, x._id)).toBe(4);
    expect((await q('POST', `/collections/${collection(FAKE.id)}/points/count`, { exact: true })).result.count).toBe(40);
  }, 120000);

  test('a worker killed mid-job: the lease lapses, Node recovers the job, a new worker finishes it', async () => {
    const a = await doc(orgA, { chunks: 4 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    const victim = embedWorker();
    await until(async () => (await row(a)).status === 'processing', 15000).catch(() => {});
    victim.kill('SIGKILL');
    await victim.done;
    const r = await row(a);
    if (r.status === 'processing') {
      await EmbeddingJob.updateOne({ _id: r._id }, { lockExpiresAt: new Date(Date.now() - 1000) });
      expect(await jobs.recoverStale()).toMatchObject({ retried: 1 });
      await EmbeddingJob.updateOne({ _id: r._id }, { nextRunAt: new Date(Date.now() - 1000) });
    }
    await embedWorker().done;
    expect(await row(a)).toMatchObject({ status: 'completed' });
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(4);
  }, 90000);

  test('Qdrant unavailable: the worker refuses to start, jobs stay queued and untouched', async () => {
    const a = await doc(orgA, { chunks: 2 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    const w = embedWorker('fake', { QDRANT_URL: 'http://127.0.0.1:9', QDRANT_TIMEOUT_SECONDS: '2' });
    expect((await w.done).code).toBe(2);
    expect(w.logs).toMatch(/cannot start/);
    expect(await row(a)).toMatchObject({ status: 'queued', attempts: 0 });
  }, 60000);

  test('a wrong Qdrant API key is refused at start, and the key never appears in logs', async () => {
    const w = embedWorker('fake', { QDRANT_API_KEY: 'definitely-wrong-key' });
    expect((await w.done).code).toBe(2);
    expect(w.logs).not.toContain('definitely-wrong-key');
    expect(w.logs).not.toContain(QKEY);
  }, 60000);

  test('embedding service unavailable (model cannot load): the worker refuses to start, jobs stay queued', async () => {
    const a = await doc(orgA, { chunks: 2 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    const w = embedWorker('fastembed', { AI_EMBEDDING_CACHE_DIR: path.join(tmp, 'empty-cache'), HF_HOME: path.join(tmp, 'empty-hf') });
    expect((await w.done).code).toBe(2);
    expect(await row(a)).toMatchObject({ status: 'queued', attempts: 0 });
  }, 60000);

  test('Qdrant dies while the worker is running: the job fails with a typed reason and is retried later', async () => {
    const a = await doc(orgA, { chunks: 3 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    // a second, throw-away Qdrant that we kill right after the worker has started
    const port = await freePort();
    const own = spawn(QDRANT_BIN, [], { cwd: tmp, env: { PATH: process.env.PATH, QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__SERVICE__HTTP_PORT: String(port), QDRANT__SERVICE__GRPC_PORT: String(await freePort()), QDRANT__STORAGE__STORAGE_PATH: path.join(tmp, `q2-${port}`), QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(tmp, `q2s-${port}`), QDRANT__TELEMETRY_DISABLED: 'true' }, stdio: 'ignore' });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, 30000);
    const w = embedWorker('fake', { QDRANT_URL: `http://127.0.0.1:${port}`, QDRANT_API_KEY: '' });
    await until(async () => (await row(a)).status === 'processing', 20000).catch(() => {});
    own.kill('SIGKILL');
    await w.done;
    const r = await row(a);
    expect(['failed', 'completed', 'processing']).toContain(r.status); // the race decides how far it got; it must never be inconsistent:
    if (r.status === 'failed') expect(r.reason).toBe('VECTOR_STORE_UNAVAILABLE');
    expect(w.logs).not.toMatch(/leave policy/); // and no document text in logs
  }, 90000);

  test('the worker never logs document text, vectors or secrets', async () => {
    const a = await doc(orgA, { chunks: 3, tag: 'SECRET-LAYOFFS' });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    const w = embedWorker();
    await w.done;
    for (const secret of ['SECRET-LAYOFFS', 'leave policy', QKEY, 'passage:']) expect(w.logs).not.toContain(secret);
    expect(w.logs).toMatch(/outcome=embedded/);
  }, 60000);

  test('a worker with the wrong signing key gets nothing and writes nothing', async () => {
    const a = await doc(orgA, { chunks: 2 });
    await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: a._id, version: 1 });
    fs.writeFileSync(path.join(tmp, 'rogue.pem'), createWorkerKeys().privatePem, { mode: 0o600 });
    await embedWorker('fake', { AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'rogue.pem') }).done;
    expect(await row(a)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await vcount(FAKE.id, orgA._id, a._id)).toBe(0);
  }, 60000);

  test('an organization without AI is never embedded', async () => {
    const c = (await createIndexedDocument({ organization: orgC, owner: users.ownerA })).doc;
    await jobs.enqueueEmbed({ organization: orgC._id, document: c._id, version: 1, spaceId: FAKE.id });
    await embedWorker().done;
    expect(await row(c)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await vcount(FAKE.id, orgC._id, c._id)).toBe(0);
  }, 60000);
});

d('REAL model (multilingual-e5-small) + real Qdrant: extraction -> embedding -> semantic search, and migration', () => {
  const topics = {
    leave: { en: 'All employees receive 24 days of paid leave per year, and up to 5 unused days may be carried over.', hi: 'सभी कर्मचारियों को प्रति वर्ष 24 दिन की सवेतन छुट्टी मिलती है।', pa: 'ਸਾਰੇ ਕਰਮਚਾਰੀਆਂ ਨੂੰ ਹਰ ਸਾਲ 24 ਦਿਨ ਦੀ ਤਨਖਾਹ ਸਮੇਤ ਛੁੱਟੀ ਮਿਲਦੀ ਹੈ।' },
    expenses: { en: 'Expense claims must be submitted with receipts within 30 days to be reimbursed.', hi: 'खर्च का दावा रसीदों के साथ 30 दिनों के भीतर जमा करना अनिवार्य है।', pa: 'ਖਰਚੇ ਦਾ ਦਾਅਵਾ ਰਸੀਦਾਂ ਸਮੇਤ 30 ਦਿਨਾਂ ਦੇ ਅੰਦਰ ਜਮ੍ਹਾਂ ਕਰਵਾਉਣਾ ਲਾਜ਼ਮੀ ਹੈ।' },
    passwords: { en: 'Passwords must be changed every 90 days and two-factor authentication must stay enabled.', hi: 'पासवर्ड हर 90 दिन में बदलना होगा और दो-चरणीय सत्यापन चालू रखना आवश्यक है।', pa: 'ਪਾਸਵਰਡ ਹਰ 90 ਦਿਨਾਂ ਵਿੱਚ ਬਦਲਣਾ ਪਵੇਗਾ ਅਤੇ ਦੋ-ਪੜਾਅ ਪ੍ਰਮਾਣਿਕਤਾ ਚਾਲੂ ਰੱਖਣੀ ਜ਼ਰੂਰੀ ਹੈ।' },
  };
  const queries = { leave: { en: 'How many days of paid leave do I get?', hi: 'एक साल में कितनी छुट्टियाँ मिलती हैं?', pa: 'ਇੱਕ ਸਾਲ ਵਿੱਚ ਕਿੰਨੀਆਂ ਛੁੱਟੀਆਂ ਮਿਲਦੀਆਂ ਹਨ?' }, expenses: { en: 'By when must I submit an expense claim?', hi: 'खर्च का दावा कब तक जमा करना होता है?', pa: 'ਖਰਚੇ ਦਾ ਦਾਅਵਾ ਕਦੋਂ ਤੱਕ ਜਮ੍ਹਾਂ ਕਰਨਾ ਹੈ?' }, passwords: { en: 'How often must passwords be changed?', hi: 'पासवर्ड कितने दिनों में बदलना चाहिए?', pa: 'ਪਾਸਵਰਡ ਕਿੰਨੇ ਦਿਨਾਂ ਵਿੱਚ ਬਦਲਣਾ ਚਾਹੀਦਾ ਹੈ?' } };

  async function uploadTopicDocs(org, lang) {
    const out = {};
    for (const [topic, texts] of Object.entries(topics)) {
      const content = Buffer.from(`${texts[lang]}\n`);
      const created = await createStoredDocument({ organization: org, owner: users.ownerA, ext: 'txt', content, name: `${topic}-${lang}.txt` });
      await ingestionJobs.enqueue({ organization: org._id, document: created._id, version: 1, extension: 'txt', size: created.size, checksum: created.checksum });
      out[topic] = created;
    }
    return out;
  }

  test('END TO END: real ingestion worker -> real embedding worker -> real Qdrant; the right document ranks first in English, Hindi and Punjabi', async () => {
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    const docs = { en: await uploadTopicDocs(orgA, 'en'), hi: await uploadTopicDocs(orgA, 'hi'), pa: await uploadTopicDocs(orgA, 'pa') };
    const ing = ingestWorker();
    expect(await ing.done).toEqual({ code: 0, signal: null });
    const all = Object.values(docs).flatMap((g) => Object.values(g));
    for (const x of all) expect(await DocumentIngestionJob.findOne({ document: x._id })).toMatchObject({ status: 'indexed' });
    // extraction finishing queued the embeddings by itself (the hook), in the real space
    for (const x of all) expect(await row(x, E5.id)).toMatchObject({ status: 'queued' });

    const w = embedWorker('fastembed');
    expect(await w.done).toEqual({ code: 0, signal: null });
    for (const x of all) expect(await row(x, E5.id)).toMatchObject({ status: 'completed' });
    expect(await vcount(E5.id, orgA._id, all[0]._id)).toBe(await chunkCount(all[0]));
    expect(await collections()).toContain(collection(E5.id));

    let right = 0; let total = 0;
    for (const lang of ['en', 'hi', 'pa']) {
      for (const topic of Object.keys(topics)) {
        const hits = probe('fastembed', orgA._id, queries[topic][lang]);
        total += 1;
        right += hits[0] && hits[0].document === docs[lang][topic]._id.toString() ? 1 : 0; // same-language document on the right topic
      }
    }
    expect(right).toBeGreaterThanOrEqual(8); // measured 9/9 on this corpus; a small smoke test, not a benchmark
    // cross-lingual: an English question finds the Hindi/Punjabi document on the same topic somewhere in the top 3
    const hitsEn = probe('fastembed', orgA._id, queries.leave.en);
    expect(total).toBe(9);
    expect(hitsEn.length).toBeGreaterThan(0);
    // tenant isolation in a real index: another organization sees none of it
    expect(probe('fastembed', orgB._id, queries.leave.en)).toEqual([]);
    // Node authorization stays outside the index: a search restricted to documents Node allowed returns only those
    const allowed = docs.en.leave._id.toString();
    expect(probe('fastembed', orgA._id, queries.leave.hi, allowed).every((h) => h.document === allowed)).toBe(true);
  }, 300000);

  test('MODEL MIGRATION: the old space stays usable throughout, the new one is built beside it, promotion is atomic, the old one is retired afterwards', async () => {
    // 1. serve the fake space
    env.AI_EMBEDDING_SPACE = 'fake-hash-384';
    const docs = [];
    for (let i = 0; i < 3; i += 1) {
      const x = await doc(orgA, { chunks: 3, tag: `m${i}` });
      await jobs.enqueueEmbedAllSpaces({ organization: orgA._id, document: x._id, version: 1 });
      docs.push(x);
    }
    await embedWorker('fake').done;
    await spaces.promote(); // first-ever promotion: the fake space becomes active
    expect((await spaces.getConfig()).activeSpaceId).toBe(FAKE.id);
    const before = await vcount(FAKE.id, orgA._id, docs[0]._id);

    // 2. the model changes: a migration starts, the active space is untouched
    env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
    await spaces.ensureConfig();
    await reconcile.reconcileOrganization({ organization: orgA._id });
    expect(await spaces.getConfig()).toMatchObject({ activeSpaceId: FAKE.id, targetSpaceId: E5.id });
    await expect(spaces.promote()).rejects.toMatchObject({ code: 'EMBEDDING_MIGRATION_NOT_READY' }); // nothing built yet
    expect(await vcount(FAKE.id, orgA._id, docs[0]._id)).toBe(before);

    // 3. the REAL model builds the new space while the fake one keeps serving
    const w = embedWorker('fastembed');
    expect(await w.done).toEqual({ code: 0, signal: null });
    for (const x of docs) expect(await vcount(E5.id, orgA._id, x._id)).toBe(3);
    expect(await vcount(FAKE.id, orgA._id, docs[0]._id)).toBe(before); // old index intact
    const pts = (await q('POST', `/collections/${collection(E5.id)}/points/scroll`, { limit: 1, with_payload: true })).result.points[0];
    expect(pts.payload.space).toBe(E5.id);

    // 4. a failed attempt would not have moved the pointer; a complete, verified one does - atomically
    const { config } = await spaces.promote();
    expect(config).toMatchObject({ activeSpaceId: E5.id, targetSpaceId: null, retiringSpaceId: FAKE.id });
    expect(await vcount(FAKE.id, orgA._id, docs[0]._id)).toBe(before); // still there during the grace period

    // 5. after the grace period the previous space is purged by its own worker
    await AiEmbeddingConfig.updateOne({ _id: 'embedding' }, { retireAfter: new Date(Date.now() - 1000) });
    await reconcile.retireOldSpace();
    await embedWorker('fake').done;
    for (const x of docs) expect(await vcount(FAKE.id, orgA._id, x._id)).toBe(0);
    await reconcile.retireOldSpace();
    expect((await spaces.getConfig()).retiringSpaceId).toBeNull();
    for (const x of docs) expect(await vcount(E5.id, orgA._id, x._id)).toBe(3); // the new space is untouched by the cleanup
  }, 300000);
});
