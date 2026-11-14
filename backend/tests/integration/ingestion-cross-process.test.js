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
 * CROSS-PROCESS: the REAL Python ingestion worker (separate OS process) against Node's REAL internal listener,
 * with real documents in real storage. Skipped (loudly) if ai/.venv is missing.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createStoredDocument, createWorkerKeys, ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const jobs = require('../../src/services/ai/ingestion/ingestionJobs.service');
const { createInternalApp } = require('../../src/internalApp');

const AI_DIR = path.resolve(__dirname, '../../../ai');
const PYTHON = path.join(AI_DIR, '.venv/bin/python');
const HAVE = fs.existsSync(PYTHON);
if (!HAVE) console.warn('[ingestion-cross-process] SKIPPED: ai/.venv not found (see ai/README.md)');
const d = HAVE ? describe : describe.skip;

const { users, createUser } = createHarness();
const keys = createWorkerKeys();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const saved = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ing-xp-'));
const workerTmp = path.join(tmp, 'worker-tmp');
let server; let url; let org; let other; let held = [];
const gate = { stallContent: false };

const fixture = (name) => fs.readFileSync(path.join(tmp, 'fixtures', name));
const extOf = (name) => name.split('.').pop();
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached in time');
};

function spawnWorker(extra = {}) {
  const proc = spawn(PYTHON, ['-m', 'app.ingestion.worker', '--once'], {
    cwd: AI_DIR,
    env: {
      PATH: process.env.PATH, // deliberately NOT the parent env: the worker must not hold a Groq key or any other secret
      AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'worker-private.pem'),
      AI_WORKER_KEY_ID: 'w1',
      AI_NODE_INTERNAL_URL: url,
      AI_INGEST_TMP_DIR: workerTmp,
      AI_INGEST_TIMEOUT_SECONDS: '60',
      // the p2 chunker sizes with the embedding model's tokenizer, read (offline) from the Hugging Face cache
      HF_HOME: process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'),
      AI_EMBEDDING_OFFLINE: 'true',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.logs = '';
  proc.stdout.on('data', (b) => { proc.logs += b; });
  proc.stderr.on('data', (b) => { proc.logs += b; });
  proc.done = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return proc;
}

async function addDoc(name, over = {}) {
  const document = await createStoredDocument({ organization: org, owner: users.ownerA, ext: extOf(name), content: fixture(name), name, ...over });
  await jobs.enqueue({ organization: org._id, document: document._id, version: 1, extension: document.extension, size: document.size, checksum: document.checksum });
  return document;
}
const jobOf = (doc) => DocumentIngestionJob.findOne({ document: doc._id });
const chunksOf = (doc) => DocumentChunk.find({ document: doc._id }).sort({ chunkIndex: 1 }).lean();

beforeAll(async () => {
  if (!HAVE) return;
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  fs.mkdirSync(workerTmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'worker-private.pem'), keys.privatePem, { mode: 0o600 });
  execFileSync(PYTHON, ['-m', 'tests.write_fixtures', path.join(tmp, 'fixtures')], { cwd: AI_DIR });
  for (const k of ['AI_WORKER_PUBLIC_KEY', 'AI_WORKER_PUBLIC_KEY_FILE', 'AI_WORKER_KEY_ID', 'AI_INGEST_MAX_ATTEMPTS']) saved[k] = env[k];
  env.AI_WORKER_PUBLIC_KEY = keys.publicPem;
  env.AI_WORKER_PUBLIC_KEY_FILE = '';
  env.AI_WORKER_KEY_ID = 'w1';
  const app = createInternalApp();
  server = http.createServer((req, res) => {
    if (gate.stallContent && req.url.includes('/content')) { held.push(res); return; } // a download that never completes
    app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
}, 60000);
afterAll(async () => {
  if (!HAVE) return;
  Object.assign(env, saved);
  held.forEach((r) => r.destroy());
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
  gate.stallContent = false;
  held = [];
  for (const f of fs.readdirSync(workerTmp)) fs.unlinkSync(path.join(workerTmp, f));
  await Promise.all([AiOrgSettings, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, Organization, User].map((m) => m.deleteMany({})));
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  other = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'ownerA', ROLES.EMPLOYEE);
  await AiOrgSettings.create([{ organization: org._id, enabled: true }, { organization: other._id, enabled: true }]);
});

d('the real Python worker against the real Node internal listener', () => {
  test('every supported format is extracted and chunked with the right source locations', async () => {
    const docs = {};
    for (const name of ['sample.txt', 'sample.csv', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.pdf']) docs[name] = await addDoc(name);
    const worker = spawnWorker();
    expect(await worker.done).toEqual({ code: 0, signal: null });

    for (const [name, doc] of Object.entries(docs)) {
      const job = await jobOf(doc);
      expect({ name, status: job.status, reason: job.reason }).toEqual({ name, status: 'indexed', reason: null });
      expect(job.stats.chunkCount).toBe((await chunksOf(doc)).length);
    }
    const loc = async (name) => (await chunksOf(docs[name]))[0].location;
    expect(await loc('sample.txt')).toMatchObject({ charStart: 0 });
    const csv = await chunksOf(docs['sample.csv']);
    expect(csv[0].location.rowStart).toBe(2);
    expect(csv[csv.length - 1].location.rowEnd).toBe(41);  // p2 sizes by real tokens, so 40 rows may span several chunks
    expect(await loc('sample.pdf')).toMatchObject({ pageStart: 1, pageEnd: 2 });
    expect(await loc('sample.pptx')).toMatchObject({ slideStart: 1, slideEnd: 2 });
    expect((await chunksOf(docs['sample.xlsx'])).map((c) => c.location.sheet).sort()).toEqual(['Budget', 'Headcount']);
    const docxText = (await chunksOf(docs['sample.docx'])).map((c) => c.text).join('\n');
    expect(docxText).toContain('Engineer | 24');
    expect((await chunksOf(docs['sample.docx']))[0].location.headingPath[0]).toBe('Leave Policy');
    expect((await chunksOf(docs['sample.xlsx'])).map((c) => c.text).join('\n')).not.toContain('HIDDEN-SHEET-DATA');
    for (const c of await chunksOf(docs['sample.txt'])) {
      expect(c.tokenEstimate).toBeGreaterThan(0);
      expect(c.tokenEstimate).toBeLessThanOrEqual(500); // p2: exact tokenizer counts, always inside the embedding window
    }
  }, 90000);

  test('documents that cannot be indexed are SKIPPED with a precise reason - never reported as indexed', async () => {
    const expected = { 'scanned.pdf': 'NO_EXTRACTABLE_TEXT', 'encrypted.pdf': 'ENCRYPTED', 'bomb.xlsx': 'ARCHIVE_LIMIT', 'corrupt.docx': 'CORRUPT', 'empty.txt': 'EMPTY' };
    const docs = {};
    for (const name of Object.keys(expected)) docs[name] = await addDoc(name);
    expect(await spawnWorker().done).toEqual({ code: 0, signal: null });
    for (const [name, reason] of Object.entries(expected)) {
      expect({ name, ...(await jobOf(docs[name])).toObject() }).toMatchObject({ name, status: 'skipped', reason });
      expect(await chunksOf(docs[name])).toHaveLength(0);
    }
  }, 90000);

  test('two workers at once process every job exactly once', async () => {
    const docs = [];
    for (let i = 0; i < 8; i += 1) docs.push(await addDoc(i % 2 ? 'sample.csv' : 'sample.txt'));
    const [a, b] = [spawnWorker({ AI_WORKER_ID: 'worker-a' }), spawnWorker({ AI_WORKER_ID: 'worker-b' })];
    await Promise.all([a.done, b.done]);
    const all = await DocumentIngestionJob.find({});
    expect(all).toHaveLength(8);
    expect(all.every((j) => j.status === 'indexed' && j.attempts === 1)).toBe(true);
    expect(new Set(all.map((j) => j.lockedBy)).size).toBeGreaterThanOrEqual(1);
    for (const doc of docs) expect((await chunksOf(doc)).length).toBeGreaterThan(0);
  }, 90000);

  test('a worker killed mid-job: the lease lapses, the job is recovered, and a new worker finishes it', async () => {
    const doc = await addDoc('sample.txt');
    gate.stallContent = true; // the worker claims, then hangs in the download
    const victim = spawnWorker();
    await until(async () => (await jobOf(doc)).status === 'processing');
    victim.kill('SIGKILL');
    await victim.done;
    gate.stallContent = false;
    held.forEach((r) => r.destroy());

    expect(await jobs.recoverStale()).toEqual({ dead: 0, retried: 0 }); // lease has not lapsed yet
    await DocumentIngestionJob.updateOne({ document: doc._id }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect(await jobs.recoverStale()).toEqual({ dead: 0, retried: 1 });
    expect(await jobOf(doc)).toMatchObject({ status: 'failed', reason: 'LOCK_EXPIRED' });
    await DocumentIngestionJob.updateOne({ document: doc._id }, { nextRunAt: new Date(Date.now() - 1000) });

    expect(await spawnWorker().done).toEqual({ code: 0, signal: null });
    expect(await jobOf(doc)).toMatchObject({ status: 'indexed', attempts: 2 });
    expect((await chunksOf(doc)).length).toBeGreaterThan(0);
  }, 90000);

  test('a document trashed while the worker is busy is never indexed', async () => {
    const doc = await addDoc('sample.txt');
    gate.stallContent = true;
    const worker = spawnWorker();
    await until(async () => (await jobOf(doc)).status === 'processing');
    await Document.updateOne({ _id: doc._id }, { deletedAt: new Date() });
    gate.stallContent = false;
    held.forEach((r) => r.destroy()); // worker's download fails -> it reports; Node refuses everything for a trashed document
    await worker.done;
    expect(await chunksOf(doc)).toHaveLength(0);
    expect(['skipped', 'failed']).toContain((await jobOf(doc)).status);
    expect((await jobOf(doc)).status).not.toBe('indexed');
  }, 90000);

  test('the worker never writes document content to its logs and leaves no temp files behind', async () => {
    await addDoc('sample.txt');
    await addDoc('sample.docx');
    await addDoc('scanned.pdf');
    const worker = spawnWorker();
    await worker.done;
    for (const secret of ['company policy', 'Leave Policy', 'Engineer', 'sample.txt', 'sample.docx']) expect(worker.logs).not.toContain(secret);
    expect(worker.logs).toMatch(/outcome=indexed/);
    expect(worker.logs).toMatch(/outcome=skipped:NO_EXTRACTABLE_TEXT/);
    expect(fs.readdirSync(workerTmp)).toEqual([]);
  }, 90000);

  test('a crashed worker\'s leftover temp file is swept when the next worker starts', async () => {
    const leftover = path.join(workerTmp, 'ingest-leftover');
    fs.writeFileSync(leftover, 'PRIVATE bytes of a document');
    const past = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(leftover, past, past);
    const fresh = path.join(workerTmp, 'ingest-recent');
    fs.writeFileSync(fresh, 'x'); // might belong to a live worker: left alone
    await spawnWorker().done;
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  }, 30000);

  test('a worker with the wrong key gets nothing and processes nothing', async () => {
    const doc = await addDoc('sample.txt');
    const { privatePem } = createWorkerKeys();
    fs.writeFileSync(path.join(tmp, 'rogue.pem'), privatePem, { mode: 0o600 });
    const rogue = spawnWorker({ AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'rogue.pem') });
    await rogue.done;
    expect(await jobOf(doc)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(rogue.logs).toMatch(/claim failed/);
  }, 60000);

  test('the worker refuses to start without a valid signing key', async () => {
    const w = spawnWorker({ AI_WORKER_SIGNING_KEY_FILE: path.join(tmp, 'missing.pem') });
    const { code } = await w.done;
    expect(code).not.toBe(0);
    expect(w.logs).toMatch(/AI_WORKER_SIGNING_KEY_FILE cannot be read/);
  }, 30000);

  test('another organization\'s documents are processed under their own organization', async () => {
    const mine = await addDoc('sample.txt');
    const theirs = await createStoredDocument({ organization: other, owner: users.ownerA, ext: 'txt', content: Buffer.from('GLOBEX secret paragraph.\n\nSecond Globex paragraph here.'), name: 'g.txt' });
    await jobs.enqueue({ organization: other._id, document: theirs._id, version: 1, extension: 'txt', size: theirs.size, checksum: theirs.checksum });
    await spawnWorker().done;
    expect((await chunksOf(mine)).every((c) => c.organization.toString() === org._id.toString())).toBe(true);
    const gl = await chunksOf(theirs);
    expect(gl.length).toBeGreaterThan(0);
    expect(gl.every((c) => c.organization.toString() === other._id.toString() && c.text.includes('Globex'))).toBe(true);
    expect((await chunksOf(mine)).some((c) => c.text.includes('Globex'))).toBe(false);
  }, 90000);
});
