jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));
// (Live tools are switched on by e2e/lib/stack.js through the REAL AI_LIVE_TOOLS_ENABLED flag: no production code is patched.)

/**
 * Phase 8 Step 8, reliability: Stop / disconnect at every phase, queued callbacks, Python restart, timeouts, the absolute deadline, concurrent
 * users, duplicate submissions and dependency failures. Real Node SSE endpoint, real Python, real tools; scripted Groq.
 * (Redis / Mongo outages are SIMULATED by failing the specific call, never by stopping the shared services.)
 */
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AppError = require('../../src/utils/app-error');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const { drainUsageOutbox } = require('../../src/services/ai/aiUsageRecorder.service');
const AuditLog = require('../../src/models/AuditLog');
const AiMessage = require('../../src/models/AiMessage');
const AIConversation = require('../../src/models/AIConversation');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const toolBudget = require('../../src/services/ai/tools/toolBudget.service');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { createStack, HAVE_PYTHON } = require('../e2e/lib/stack');
const { USAGE, textPlan, toolPlan } = require('../e2e/lib/fakeGroq');

if (!HAVE_PYTHON) console.warn('[ai-e2e-reliability] SKIPPED: ai/.venv not found');
const d = HAVE_PYTHON ? describe : describe.skip;

const harness = createHarness();
const { users } = harness;
const S = createStack(harness, { pythonEnv: { AI_TOOL_KEEPALIVE_MS: '300' } }); // Python sends a keepalive about every 300 ms while a model call is in flight
const redis = () => createRedisClient();
const types = (events) => events.map((e) => e.type);
const lastUsage = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The terminal error of a request: an SSE `error` frame once streaming began, otherwise the ordinary HTTP error body (failures before the first frame). */
const errorCodeOf = (r) => {
  if (r.status === 200) return r.events.find((e) => e.type === 'error')?.code;
  try { return JSON.parse(r.body).code; } catch { return undefined; }
};
const clean = async () => ({ reservations: await redis().keys('test:ai:q:*:r:*'), budgets: await redis().keys('test:ai:tool:*') });
const settled = async (n = 1) => S.until(async () => (await AiUsageEvent.countDocuments()) === n && (await redis().keys('test:ai:q:*:r:*')).length === 0 && (await redis().keys('test:ai:tool:*')).length === 0, 8000);
/** Makes every tool run slowly on Node (the tool itself, not the network), counting how many actually started. */
function slowTools(ms) {
  const real = aiScope.resolveAiScope;
  const probe = { started: 0 };
  jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { probe.started += 1; await sleep(ms); return real(...a); });
  return probe;
}

beforeAll(async () => {
  if (!HAVE_PYTHON) return;
  await connectTestDb();
  await connectRedis();
  await S.start();
}, 90000);
afterAll(async () => {
  if (!HAVE_PYTHON) return;
  await S.stop();
  await hub.shutdown();
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  if (!HAVE_PYTHON) return;
  jest.restoreAllMocks();
  await S.reset();
}, 30000);

d('Stop / disconnect at every phase', () => {
  test('before the first Groq response: Groq is disconnected, no tool runs, nothing is charged, everything is released', async () => {
    S.groq.queue({ ...textPlan('never'), delayMs: 4000 });
    const chat = S.startChat('emp1', 'hi');
    await S.until(() => S.groq.requests.length === 1);
    chat.abort();
    await chat.done;
    await S.until(() => S.groq.disconnects >= 1);
    await settled();
    expect(await lastUsage()).toMatchObject({ status: 'cancelled', chargedTokens: 0 });
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
    expect(S.py.logs).toMatch(/outcome=cancelled/);
  }, 60000);

  test('while Groq is generating, before ANY frame has reached the browser: the user message is KEPT (Step 9D), the reply is incomplete, the conversation is free', async () => {
    S.groq.queue({ ...textPlan('x', { pieces: ['one ', 'two ', 'three '] }), gapMs: 300, hang: true });
    const chat = S.startChat('emp1', 'tell me a story');
    await S.until(() => S.groq.requests.length === 1);
    await sleep(500);
    chat.abort();
    await chat.done;
    await settled();
    await S.until(async () => !(await AIConversation.findById(chat.conversationId).lean()).activeRequestKey, 5000);
    const rows = await AiMessage.find({ conversation: chat.conversationId }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => [r.role, r.status])).toEqual([['user', 'complete'], ['assistant', 'incomplete']]);
    expect(rows[0].content).toBe('tell me a story'); // not silently lost
    expect(rows[1]).toMatchObject({ content: '', finishReason: 'cancelled' });
    S.groq.queue(textPlan('next answer'));
    const next = await S.chat('emp1', 'again', { conversationId: chat.conversationId });
    expect(next.status).toBe(200);
    expect(types(next.events)).toContain('done'); // not stuck "busy"
    expect(await AiMessage.countDocuments({ conversation: chat.conversationId, role: 'user' })).toBe(2); // exactly the two submissions, no duplicates
  }, 60000);

  test('after the first tool_activity the turn IS saved: Stop then leaves the user message and an incomplete assistant reply', async () => {
    const probe = slowTools(3000);
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }]), textPlan('never'));
    const chat = S.startChat('emp1', 'projects?');
    await S.until(() => probe.started === 1);
    chat.abort();
    await chat.done;
    await settled();
    await S.until(async () => (await AiMessage.findOne({ conversation: chat.conversationId, role: 'assistant' }).lean())?.status === 'incomplete', 5000); // the row settles a few ms after the usage event
    const rows = await AiMessage.find({ conversation: chat.conversationId }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1].status).toBe('incomplete');
    expect(rows[1].content).toBe(''); // no tool data, no partial JSON
  }, 60000);

  test('while a tool callback is running: the tool is aborted on Node, no further Groq call, no late result anywhere', async () => {
    const probe = slowTools(3000);
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }]), textPlan('LATE-RESULT-MUST-NOT-APPEAR'));
    const chat = S.startChat('emp1', 'projects?');
    await S.until(() => probe.started === 1);
    chat.abort();
    const r = await chat.done;
    await settled();
    await sleep(500);
    expect(S.groq.requests).toHaveLength(1);
    expect(JSON.stringify(r.events)).not.toContain('LATE-RESULT');
    const ev = await lastUsage();
    expect(ev).toMatchObject({ status: 'cancelled', toolCalls: 1 });
    expect(ev.chargedTokens).toBeGreaterThan(0); // a tool ran, so the paid round is charged (estimate)
    expect(await AiUsageEvent.countDocuments()).toBe(1); // settled once
  }, 60000);

  test('while a second callback is QUEUED: the queued call never starts (two run, the third is dropped)', async () => {
    const probe = slowTools(3000);
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects', args: { limit: 1 } }, { id: 'b', name: 'list_projects', args: { limit: 2 } }, { id: 'c', name: 'list_projects', args: { limit: 3 } }]), textPlan('never'));
    const chat = S.startChat('emp1', 'projects?');
    await S.until(() => probe.started === 2);
    await sleep(300);
    expect(probe.started).toBe(2); // the concurrency cap held
    chat.abort();
    await chat.done;
    await settled();
    await sleep(600);
    expect(probe.started).toBe(2); // ...and cancellation did not release the third
    expect(S.groq.requests).toHaveLength(1);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBeLessThanOrEqual(2);
  }, 60000);

  test('a plain client disconnect mid-request is the same as Stop (the server cannot tell the difference)', async () => {
    const probe = slowTools(3000);
    S.groq.queue(toolPlan([{ id: 'a', name: 'get_team' }, { id: 'b', name: 'list_projects' }]), textPlan('never'));
    const chat = S.startChat('emp1', 'q');
    await S.until(() => probe.started >= 1);
    chat.req.abort(); // the socket is destroyed
    await chat.done;
    await settled();
    expect(await lastUsage()).toMatchObject({ status: 'cancelled' });
  }, 60000);
});

d('Python restart', () => {
  test('Python killed mid-request: Node fails cleanly (an HTTP error, as nothing had streamed), releases everything, and works again after a restart', async () => {
    S.groq.queue({ ...textPlan('x'), delayMs: 5000 });
    const chat = S.startChat('emp1', 'hi');
    try {
      await S.until(() => S.groq.requests.length === 1);
      S.py.kill('SIGKILL');
      const r = await chat.done;
      expect(r.status >= 500 || types(r.events).includes('error')).toBe(true); // no frame had been sent yet: an ordinary HTTP error
      expect(JSON.stringify(r.body || r.events)).not.toMatch(/eyJ|ECONNREFUSED|127\.0\.0\.1|test:ai/); // no tokens, addresses or key names (NOTE: outside production the HTTP error body also carries a `stack` field: existing dev-only behaviour, see report)
      await settled();
      expect(await lastUsage()).toMatchObject({ status: 'error', chargedTokens: 0 });
    } finally {
      await S.restartPython(); // always: later tests need a live service
    }
    S.groq.reset();
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }]), textPlan('back online'));
    const ok = await S.chat('emp1', 'projects?');
    expect(types(ok.events)).toEqual(['meta', 'tool_activity', 'text', 'usage', 'done']);
  }, 90000);
});

d('timeouts and the absolute deadline', () => {
  test('a slow tool on Node hits the per-call limit: the model gets AI_TOOL_TIMEOUT and the answer still completes', async () => {
    env.AI_TOOL_TIMEOUT_MS = 300;
    slowTools(1500);
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }]), textPlan('could not load'));
    const r = await S.chat('emp1', 'projects?');
    expect(types(r.events)).toContain('done');
    expect(S.toolResults(1)[0]).toMatchObject({ status: 'error', error: 'AI_TOOL_TIMEOUT' });
    await settled();
  }, 60000);

  test('Groq slower than the first-byte limit: a clean error, no tool, nothing charged', async () => {
    S.groq.queue({ ...textPlan('late'), delayMs: 6000 });
    const startedAt = Date.now();
    const r = await S.chat('emp1', 'hi');
    expect(Date.now() - startedAt).toBeLessThan(9000);
    expect(errorCodeOf(r)).toBe('AI_PROVIDER_TIMEOUT'); // before any frame: an ordinary HTTP error
    await settled();
    expect(await lastUsage()).toMatchObject({ status: 'error', chargedTokens: 0 });
  }, 60000);

  test('Node\'s IDLE timer vs a legitimately slow model round (a retry, a slow provider): keepalives keep a healthy request alive', async () => {
    // Node would give up after 1.2 s of silence; Groq needs ~2 s for this round (inside Python's own first-byte limit). Without a keepalive that is a failure.
    Object.assign(env, { AI_SERVICE_IDLE_TIMEOUT_MS: 1200, AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 1200 });
    S.groq.queue({ ...toolPlan([{ id: 'a', name: 'list_projects' }], { usage: USAGE(1000, 10) }), delayMs: 2000 }, { ...textPlan('survived', { usage: USAGE(1200, 10) }), delayMs: 2000 });
    const startedAt = Date.now();
    const r = await S.chat('emp1', 'projects?');
    expect(types(r.events)).toEqual(['meta', 'tool_activity', 'text', 'usage', 'done']);
    expect(Date.now() - startedAt).toBeGreaterThan(3800); // two ~2 s silent model rounds, each longer than Node's idle limit
    await settled();
    expect(await lastUsage()).toMatchObject({ status: 'success', chargedTokens: 2220 });
  }, 60000);

  test('...but a keepalive can never extend the ABSOLUTE ceiling: a model that is slow forever is still cut off at the deadline', async () => {
    Object.assign(env, { AI_REQUEST_CEILING_MS: 17000, AI_TOOL_TIMEOUT_MS: 3000, AI_TOOL_TOTAL_MS: 4000, AI_SERVICE_IDLE_TIMEOUT_MS: 1200, AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 1200 });
    S.groq.queue({ ...textPlan('never'), delayMs: 60000 }); // Groq never answers; Python's keepalives would go on, but its deadline (ceiling - 10 s = 7 s) ends it
    const startedAt = Date.now();
    const r = await S.chat('emp1', 'hi');
    const took = Date.now() - startedAt;
    expect(took).toBeLessThan(10500);
    expect(errorCodeOf(r)).toMatch(/AI_PROVIDER_TIMEOUT|AI_SERVICE_TIMEOUT/);
    await settled();
  }, 60000);

  test('the ABSOLUTE deadline: several slow model rounds cannot outlive the request ceiling, and no late answer is delivered', async () => {
    // ceiling 17 s => Python's deadline for this request is 17 - 10 = 7 s. Four model calls of ~2.2 s each would need ~9 s.
    Object.assign(env, { AI_REQUEST_CEILING_MS: 17000, AI_TOOL_TIMEOUT_MS: 3000, AI_TOOL_TOTAL_MS: 4000 });
    const slow = (plan) => ({ ...plan, delayMs: 2200 });
    S.groq.queue(slow(toolPlan([{ id: 'a', name: 'list_projects', args: { limit: 1 } }], { usage: USAGE(1000, 10) })), slow(toolPlan([{ id: 'b', name: 'get_team' }], { usage: USAGE(1000, 10) })), slow(toolPlan([{ id: 'c', name: 'list_my_tasks' }], { usage: USAGE(1000, 10) })), slow(textPlan('TOO-LATE')));
    const startedAt = Date.now();
    const r = await S.chat('emp1', 'everything');
    const took = Date.now() - startedAt;
    expect(errorCodeOf(r)).toBe('AI_PROVIDER_TIMEOUT'); // streaming had begun (tool_activity), so it is an SSE error frame
    expect(JSON.stringify(r.events)).not.toContain('TOO-LATE');
    expect(took).toBeLessThan(9500); // ~7 s: well inside the 17 s ceiling, and the answer round never completed
    expect(S.groq.requests.length).toBeLessThanOrEqual(4);
    await settled();
    const ev = await lastUsage();
    expect(ev.status).toBe('error');
    expect(ev.chargedTokens).toBeGreaterThan(0); // the rounds that DID finish are charged (Python reports them before the error)
  }, 60000);

  test('limits that leave Python no room to work (a ceiling barely above the tool budget) fail CLOSED with a clean error, never a run with less safety', async () => {
    Object.assign(env, { AI_REQUEST_CEILING_MS: 16000, AI_TOOL_TOTAL_MS: 5000 }); // Python deadline 6 s < one call (5 s + grace + connect)
    S.groq.queue(textPlan('never'));
    const r = await S.chat('emp1', 'hi');
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(S.groq.requests).toHaveLength(0); // refused before any model call
    await settled();
  }, 60000);
});

d('concurrency and duplicates', () => {
  test("one user's Stop does not touch another user's request; both settle independently", async () => {
    // route by question so the two interleaved requests each get their own script
    const router = (body) => {
      const q = JSON.stringify(body.messages);
      const hasTool = body.messages.some((m) => m.role === 'tool');
      if (q.includes('EMP1-QUESTION')) return { ...toolPlan([{ id: 'a', name: 'list_projects' }]), delayMs: 1500 };
      return hasTool ? textPlan('EMP2-FINAL-ANSWER') : toolPlan([{ id: 'b', name: 'list_my_tasks' }]);
    };
    S.groq.queue(router, router, router);
    const slowFor1 = slowTools(0);
    const one = S.startChat('emp1', 'EMP1-QUESTION');
    const two = S.startChat('emp2', 'EMP2-QUESTION');
    await S.until(() => S.groq.requests.length >= 1);
    await sleep(200);
    one.abort();
    const [, resultTwo] = await Promise.all([one.done, two.done]);
    expect(types(resultTwo.events)).toEqual(['meta', 'tool_activity', 'text', 'usage', 'done']);
    expect(JSON.stringify(resultTwo.events)).toContain('EMP2-FINAL-ANSWER');
    await settled(2);
    const events = await AiUsageEvent.find({}).lean();
    expect(events.map((e) => e.status).sort()).toEqual(['cancelled', 'success']);
    expect(new Set(events.map((e) => String(e.user))).size).toBe(2);
    expect(slowFor1.started).toBeGreaterThanOrEqual(0);
  }, 60000);

  test('a model repeating an identical call runs it ONCE (Python blocks the repeat; Node never sees it)', async () => {
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects', args: { limit: 3 } }, { id: 'b', name: 'list_projects', args: { limit: 3 } }]), toolPlan([{ id: 'c', name: 'list_projects', args: { limit: 3 } }]), textPlan('done'));
    await S.chat('emp1', 'q');
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(1);
    const dup = S.toolResults(1).find((t) => t.id === 'b');
    expect(dup).toMatchObject({ status: 'error', error: 'AI_TOOL_DUPLICATE' });
  }, 60000);

  test('the same message submitted twice at once on one conversation: ONE reply, ONE usage event', async () => {
    S.groq.queue({ ...textPlan('only one'), delayMs: 700 }, textPlan('SECOND-MUST-NOT-HAPPEN'));
    const conv = await S.createConversation('emp1');
    const first = S.startChat('emp1', 'same question', { conversationId: conv.id });
    await S.until(() => S.groq.requests.length === 1);
    const second = await S.chat('emp1', 'same question', { conversationId: conv.id });
    expect(second.status).toBe(409); // the conversation is busy answering
    await first.done;
    await settled();
    expect(S.groq.requests).toHaveLength(1);
    expect(await AiMessage.countDocuments({ conversation: conv.id, role: 'assistant' })).toBe(1);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  }, 60000);
});

d('dependency failures fail CLOSED (simulated per call; the shared services are never stopped)', () => {
  test('Redis limits unavailable: refused before Python and Groq, nothing left behind, the conversation is not stuck', async () => {
    const conv = await S.createConversation('emp1');
    jest.spyOn(limits, 'admit').mockRejectedValue(new AppError('AI limits unavailable', 503, 'AI_LIMITS_UNAVAILABLE'));
    const r = await S.chat('emp1', 'hi', { conversationId: conv.id });
    expect(r.status).toBe(503);
    expect(S.groq.requests).toHaveLength(0);
    jest.restoreAllMocks();
    S.groq.queue(textPlan('recovered'));
    const again = await S.chat('emp1', 'hi again', { conversationId: conv.id });
    expect(again.status).toBe(200); // the failed turn was rolled back; the conversation is usable
    await settled();
  }, 60000);

  test('the tool budget cannot be opened (Redis trouble): the request fails closed, quota is released, no generate request is made', async () => {
    jest.spyOn(toolBudget, 'openBudget').mockRejectedValue(new AppError('AI limits unavailable', 503, 'AI_LIMITS_UNAVAILABLE'));
    const r = await S.chat('emp1', 'hi');
    expect(r.status).toBe(503);
    expect(S.groq.requests).toHaveLength(0);
    expect((await clean()).reservations).toEqual([]);
    expect((await limits.readCounters({ orgId: String(users.emp1.organization), userId: String(users.emp1._id), timeZone: 'Asia/Kolkata' })).userDailyUsed).toBe(0);
  }, 60000);

  test('the database failing while a callback loads the user: the model is told the tool failed, no data leaks, the request still ends cleanly', async () => {
    const realFind = User.findById.bind(User);
    let broken = false;
    jest.spyOn(User, 'findById').mockImplementation((...a) => (broken ? { then: (_, reject) => reject(new Error('mongo down')) } : realFind(...a)));
    S.groq.queue(async () => { broken = true; return toolPlan([{ id: 'a', name: 'list_projects' }]); }, async () => { broken = false; return textPlan('I could not retrieve that.'); });
    const r = await S.chat('emp1', 'projects?');
    expect(types(r.events)).toContain('done');
    expect(S.toolResults(1)[0]).toMatchObject({ status: 'error' });
    expect(JSON.stringify(S.toolResults(1))).not.toMatch(/Apollo|mongo down/);
    await settled();
  }, 60000);

  test('the usage ledger write failing: the answer still completes, the usage parks durably in Redis, and a later drain records it exactly once', async () => {
    jest.spyOn(AiUsageEvent, 'updateOne').mockRejectedValue(new Error('mongo write failed'));
    S.groq.queue(textPlan('fine', { usage: USAGE(500, 5) }));
    const r = await S.chat('emp1', 'hi');
    expect(types(r.events)).toContain('done');
    await S.until(async () => (await redis().lLen('test:ai:usage-outbox')) === 1, 8000);
    expect((await limits.readCounters({ orgId: String(users.emp1.organization), userId: String(users.emp1._id), timeZone: 'Asia/Kolkata' })).userDailyUsed).toBe(505); // quota settled regardless
    jest.restoreAllMocks();
    await drainUsageOutbox(); // the background job, run by hand
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await lastUsage()).toMatchObject({ status: 'success', chargedTokens: 505 });
    expect(await redis().lLen('test:ai:usage-outbox')).toBe(0);
    await drainUsageOutbox();
    expect(await AiUsageEvent.countDocuments()).toBe(1); // idempotent
  }, 60000);
});
