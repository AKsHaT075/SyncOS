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
 * CROSS-PROCESS: real Python (uvicorn) <- real Node client/pipeline, with a local fake Groq HTTP server.
 * Proves the streaming path, disconnect propagation, Python-side retries, and Redis replay protection
 * across two Python instances. Skipped (loudly) if ai/.venv is not set up. Never uses a real Groq key.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const aiService = require('../../src/services/ai/aiService');
const client = require('../../src/services/ai/aiService/client');
const tokens = require('../../src/services/ai/aiService/tokens');
const { completeAiRequest, estimateTokens, streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const AI_DIR = path.resolve(__dirname, '../../../ai');
const PYTHON = path.join(AI_DIR, '.venv/bin/python');
const HAVE_PYTHON = fs.existsSync(PYTHON);
if (!HAVE_PYTHON) console.warn('[ai-cross-process] SKIPPED: ai/.venv not found (see ai/README.md)');
const d = HAVE_PYTHON ? describe : describe.skip;

const { users, createUser } = createHarness();
const pair = createKeyPair();
const GROQ_KEY = 'gsk_CROSS_PROCESS_FAKE_KEY';
const MESSAGES = [{ role: 'user', content: 'PROMPT-SECRET hello' }];
const OUTPUT_CAP = 100;
const redis = () => createRedisClient();
const oid = () => new mongoose.Types.ObjectId();
const saved = {};
const procs = [];
let groq; let groqPort; let org;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
};

/** Fake Groq (OpenAI-compatible SSE). Plans are consumed in order. */
function createGroq() {
  const state = { requests: [], plans: [], disconnects: 0 };
  const sseLine = (o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
  const chunk = (content, finish = null, extra = {}) => ({ id: 'cmpl-1', model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }], ...extra });
  state.chunk = chunk;
  state.default = () => ({ chunks: [chunk('Hello'), chunk(' world'), chunk(null, 'stop', { usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })] });
  state.server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    state.requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString() || '{}'), url: req.url });
    res.on('close', () => { if (!res.writableFinished) state.disconnects += 1; });
    const plan = state.plans.shift() || state.default();
    if (plan.status) {
      res.writeHead(plan.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'PROMPT-SECRET echoed upstream' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of plan.chunks) {
      res.write(sseLine(c));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, plan.gapMs || 5));
    }
    if (plan.hang) return undefined;
    if (plan.truncate) return res.end();
    res.write(sseLine('[DONE]'));
    return res.end();
  });
  return state;
}

async function startPython(port, extra = {}) {
  const proc = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:build', '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], {
    cwd: AI_DIR,
    env: {
      PATH: process.env.PATH,
      AI_JWT_PUBLIC_KEY: pair.publicKey,
      AI_JWT_KEY_ID: 'v1',
      GROQ_API_KEY: GROQ_KEY,
      GROQ_BASE_URL: `http://127.0.0.1:${groqPort}/openai/v1`,
      AI_REPLAY_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379',
      AI_REDIS_PREFIX: 'test:ai-service',
      AI_MAX_RETRIES: '2',
      PORT: String(port),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.logs = '';
  proc.stdout.on('data', (b) => { proc.logs += b; });
  proc.stderr.on('data', (b) => { proc.logs += b; });
  procs.push(proc);
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, 15000);
  return { port, proc, url: `http://127.0.0.1:${port}` };
}

const ask = (extra = {}) => completeAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, ...extra });
const ids = () => ({ orgId: users.emp.organization.toString(), userId: users.emp._id.toString() });
const used = async () => (await limits.readCounters({ ...ids(), timeZone: 'Asia/Kolkata' })).userDailyUsed;
const events = () => AiUsageEvent.find({}).sort({ createdAt: 1 }).lean();
async function clearRedis() {
  const r = redis();
  const keys = [...(await r.keys('test:ai:*')), ...(await r.keys('test:ai-service:*'))];
  if (keys.length) await r.del(keys);
}

let py; let py2;
beforeAll(async () => {
  if (!HAVE_PYTHON) return;
  await connectTestDb();
  await connectRedis();
  groq = createGroq();
  groqPort = await new Promise((resolve) => groq.server.listen(0, '127.0.0.1', () => resolve(groq.server.address().port)));
  py = await startPython(await freePort());
  py2 = await startPython(await freePort());
  for (const k of ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_MAX_OUTPUT_TOKENS']) saved[k] = env[k];
  aiService.resetEngine();
}, 60000);
afterAll(async () => {
  if (!HAVE_PYTHON) return;
  Object.assign(env, saved);
  for (const p of procs) p.kill('SIGKILL');
  groq.server.closeAllConnections?.();
  await new Promise((r) => groq.server.close(r));
  await hub.shutdown();
  await clearRedis();
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  if (!HAVE_PYTHON) return;
  groq.requests.length = 0;
  groq.plans.length = 0;
  groq.disconnects = 0;
  aiService.resetEngine();
  env.AI_SERVICE_URL = py.url;
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_SERVICE_KEY_ID = 'v1';
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  env.AI_MAX_OUTPUT_TOKENS = OUTPUT_CAP;
  env.AI_GLOBAL_ENABLED = true;
  await clearRedis();
  await Promise.all([AiOrgSettings.deleteMany({}), AiUsageEvent.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await AiOrgSettings.create({ organization: org._id, enabled: true });
});

d('streaming through the real Python service', () => {
  test('status: the service reports configured + models, and Node holds no Groq key', async () => {
    const status = await client.status();
    expect(status).toMatchObject({ reachable: true, configured: true, provider: 'groq', replayStore: 'redis', models: { chat: 'openai/gpt-oss-120b' } });
    expect(JSON.stringify(status)).not.toContain(GROQ_KEY);
    expect(env.GROQ_API_KEY).toBeUndefined(); // the key lives only in the Python process; Node has no such setting
  });

  test('end to end: Node -> Python -> (fake) Groq -> events -> metered usage', async () => {
    const result = await ask();
    expect(result.text).toBe('Hello world');
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 4, totalTokens: 15, estimated: false });
    expect(groq.requests).toHaveLength(1);
    expect(groq.requests[0].headers.authorization).toBe(`Bearer ${GROQ_KEY}`);
    expect(groq.requests[0].body).toMatchObject({ model: 'openai/gpt-oss-120b', stream: true, max_completion_tokens: OUTPUT_CAP });
    expect(await used()).toBe(15);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'success', chargedTokens: 15, model: 'openai/gpt-oss-120b', provider: 'groq', quotaSettled: true });
    expect(event.estimatedCostMicros).toBeGreaterThan(0);
  });

  test('text really streams incrementally (chunks arrive before the stream ends)', async () => {
    groq.plans.push({ gapMs: 80, chunks: [groq.chunk('a'), groq.chunk('b'), groq.chunk('c'), groq.chunk(null, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })] });
    const stamps = [];
    for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES })) if (e.type === 'text') stamps.push(Date.now());
    expect(stamps).toHaveLength(3);
    expect(stamps[2] - stamps[0]).toBeGreaterThan(100); // spread over time, not delivered in one lump
  });

  test('the output cap in the signed token is what reaches Groq (a body cannot raise it)', async () => {
    await ask({ maxOutputTokens: 40 });
    expect(groq.requests[0].body.max_completion_tokens).toBe(40);
  });

  test('Python retries Groq before output; Node sees ONE request, ONE event, ONE charge', async () => {
    groq.plans.push({ status: 503 }, { status: 429 });
    const result = await ask();
    expect(result.text).toBe('Hello world');
    expect(groq.requests).toHaveLength(3); // two failed attempts + the good one, all inside Python
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await used()).toBe(15);
  });

  test('Groq failing for good: refunded, upstream text never reaches Node', async () => {
    groq.plans.push({ status: 503 }, { status: 503 }, { status: 503 });
    let error;
    try { await ask(); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: C.UNAVAILABLE, streamStarted: false });
    expect(JSON.stringify({ m: error.message, c: error.code, d: error.details })).not.toContain('PROMPT-SECRET');
    expect(await used()).toBe(0);
    expect((await events())[0]).toMatchObject({ status: 'error', chargedTokens: 0 });
  });

  test('Groq cuts the stream after output: Node gets an error with streamStarted and an estimate is charged', async () => {
    groq.plans.push({ chunks: [groq.chunk('partial answer')], truncate: true });
    let error;
    try { await ask(); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: C.UNAVAILABLE, streamStarted: true });
    expect(groq.requests).toHaveLength(1); // never replayed after output
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', streamStarted: true, tokensEstimated: true, quotaSettled: true });
    expect(event.chargedTokens).toBeGreaterThanOrEqual(estimateTokens(MESSAGES));
    expect(await used()).toBe(event.chargedTokens);
  });

  test('DISCONNECT PROPAGATION: aborting in Node closes the upstream Groq connection', async () => {
    groq.plans.push({ chunks: [groq.chunk('streaming...')], hang: true });
    const controller = new AbortController();
    let error;
    try {
      for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, signal: controller.signal })) {
        if (e.type === 'text') controller.abort();
      }
    } catch (e) { error = e; }
    expect(error.code).toBe(C.ABORTED);
    await until(() => groq.disconnects === 1, 5000); // Node -> Python -> Groq all torn down
    const [event] = await events();
    expect(event).toMatchObject({ status: 'cancelled', streamStarted: true, quotaSettled: true });
    expect(await used()).toBe(event.chargedTokens);
    expect(groq.requests).toHaveLength(1); // and it was not retried
  });

  test('Python dies mid-stream: truncated => error, estimate charged, slot and reservation released', async () => {
    const victim = await startPython(await freePort());
    env.AI_SERVICE_URL = victim.url;
    aiService.invalidateStatus();
    groq.plans.push({ chunks: [groq.chunk('about to die')], hang: true });
    let error;
    const run = (async () => {
      try {
        for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES })) if (e.type === 'text') victim.proc.kill('SIGKILL');
      } catch (e) { error = e; }
    })();
    await run;
    expect(error).toMatchObject({ code: C.SERVICE_UNAVAILABLE, streamStarted: true });
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', streamStarted: true, tokensEstimated: true, quotaSettled: true });
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
    expect(await redis().zCard(limits.keys.inflight(ids().orgId, ids().userId))).toBe(0);
  }, 20000);
});

d('replay protection is shared across Python instances (Redis)', () => {
  const generate = (service, token, body = { purpose: 'chat', messages: MESSAGES }) =>
    fetch(`${service.url}/internal/v1/generate`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const mint = (requestKey = crypto.randomUUID()) => tokens.signGenerateToken({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey, maxOutputTokens: 50 });

  test('a token used on instance A is refused on instance B', async () => {
    const token = mint();
    const first = await generate(py, token);
    expect(first.status).toBe(200);
    await first.text();
    const replay = await generate(py2, token);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: { code: 'REPLAYED' } });
    expect((await generate(py, token)).status).toBe(409);
    expect(groq.requests).toHaveLength(1);
  });

  test('20 concurrent attempts spread over both instances: exactly one runs', async () => {
    const token = mint();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => generate(i % 2 ? py : py2, token).then(async (r) => { await r.text(); return r.status; })));
    expect(results.filter((s) => s === 200)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(19);
    expect(groq.requests).toHaveLength(1);
  });

  test('the replay record is real and expires with the token', async () => {
    const id = crypto.randomUUID();
    await (await generate(py, mint(id))).text();
    const ttl = await redis().ttl(`test:ai-service:jti:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(45);
  });

  test('with Redis unreachable Python refuses (fail closed) instead of running unprotected', async () => {
    const isolated = await startPython(await freePort(), { REDIS_URL: 'redis://127.0.0.1:1' });
    const res = await generate(isolated, mint());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('REPLAY_STORE_UNAVAILABLE');
    expect(groq.requests).toHaveLength(0);
  }, 20000);
});

d('the Python service as a hostile-network citizen', () => {
  test('refuses tokens signed by the wrong key, and says nothing useful about why', async () => {
    const forged = createKeyPair();
    const saveKey = env.AI_SERVICE_SIGNING_KEY;
    env.AI_SERVICE_SIGNING_KEY = forged.privateKey;
    aiService.invalidateStatus();
    // The gate probes readiness with the same key, is rejected, and fails closed before any limit or call.
    let gateError;
    try { await ask(); } catch (e) { gateError = e; }
    expect(gateError.code).toBe(C.NOT_CONFIGURED);
    // Bypassing the gate, the generate call itself is refused too.
    let direct;
    try {
      for await (const e of client.chat({ identity: { userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: crypto.randomUUID() }, purpose: 'chat', messages: MESSAGES, maxOutputTokens: 10 })) void e;
    } catch (e) { direct = e; }
    env.AI_SERVICE_SIGNING_KEY = saveKey;
    aiService.invalidateStatus();
    expect(direct.code).toBe(C.SERVICE_AUTH);
    expect(groq.requests).toHaveLength(0);
    expect(await AiUsageEvent.countDocuments()).toBe(0);
  });

  test('exposes no docs, no schema, and a minimal health route', async () => {
    for (const p of ['/docs', '/redoc', '/openapi.json']) expect((await fetch(`${py.url}${p}`)).status).toBe(404);
    expect(await (await fetch(`${py.url}/health`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${py.url}/internal/v1/status`)).status).toBe(401);
  });

  test('Python\'s logs contain no prompts, completions, keys or tokens', async () => {
    const t = tokens.signGenerateToken({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: crypto.randomUUID(), maxOutputTokens: 50 });
    groq.plans.push({ status: 503 }, { status: 503 }, { status: 503 });
    await (await fetch(`${py.url}/internal/v1/generate`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'chat', messages: MESSAGES }) })).text();
    await ask();
    await new Promise((r) => setTimeout(r, 200));
    const logs = py.proc.logs + py2.proc.logs;
    for (const secret of ['PROMPT-SECRET', 'Hello world', GROQ_KEY, t]) expect(logs).not.toContain(secret);
  });
});
