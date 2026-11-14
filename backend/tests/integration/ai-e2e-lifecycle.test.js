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
 * Phase 8 Step 8: the WHOLE lifecycle through the real Node HTTP/SSE endpoint, the real Python service, and a scripted Groq, with the layer that
 * enforces each step identified. Plus usage accounting (reservation, settlement, every Groq round, estimates, durability, pricing).
 */
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const AIConversation = require('../../src/models/AIConversation');
const AiMessage = require('../../src/models/AiMessage');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const tokens = require('../../src/services/ai/aiService/tokens');
const toolBudget = require('../../src/services/ai/tools/toolBudget.service');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { estimateCostMicros } = require('../../src/services/ai/pricing');
const { createStack, HAVE_PYTHON } = require('../e2e/lib/stack');
const { USAGE, textPlan, toolPlan } = require('../e2e/lib/fakeGroq');

if (!HAVE_PYTHON) console.warn('[ai-e2e-lifecycle] SKIPPED: ai/.venv not found');
const d = HAVE_PYTHON ? describe : describe.skip;

const harness = createHarness();
const { users, as, tokenFor } = harness;
const S = createStack(harness);
const redis = () => createRedisClient();
const types = (events) => events.map((e) => e.type);
const lastUsage = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];
const counters = (key) => limits.readCounters({ orgId: String(users[key].organization), userId: String(users[key]._id), timeZone: 'Asia/Kolkata' });

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

d('the 20-step lifecycle, one real request (employee asks about projects)', () => {
  test('every transition happens, in order, and each check is made by the layer that owns it', async () => {
    const { users: U } = S.F;
    const signGen = jest.spyOn(tokens, 'signGenerateToken');
    const signCb = jest.spyOn(tokens, 'signCallbackToken');
    const open = jest.spyOn(toolBudget, 'openBudget');
    const inFlight = {};
    // Groq round 1 (tool call). While it is "thinking" the request is mid-flight: we can observe Node's state at that instant.
    S.groq.queue(async () => {
      inFlight.reservations = (await redis().keys('test:ai:q:*:r:*')).length;
      inFlight.budgets = (await redis().keys('test:ai:tool:*')).length;
      inFlight.inflightSet = (await redis().keys('test:ai:rl:*:c:*')).length;
      return toolPlan([{ id: 'call_1', name: 'list_projects', args: { limit: 10 } }], { usage: USAGE(1700, 40) });
    }, textPlan('You can see 3 projects: Apollo and two others.', { usage: USAGE(2100, 30), pieces: ['You can see 3 projects: ', 'Apollo and two others.'] }));

    // 1-3: submit through AI Studio's endpoint with a real Bearer token (Node authenticates).
    const anon = await harness.makeAgent('anon'); // a valid CSRF token but NO credentials
    expect((await anon.post('/api/v1/ai/conversations').set('x-csrf-token', anon.csrfToken).send({})).status).toBe(401); // LAYER Node: authentication
    const result = await S.chat('emp1', 'How many projects can I see?');
    expect(result.status).toBe(200);

    // 4-5: AI + live-data settings were checked, a reservation was held and a tool budget opened (LAYER Node), then released.
    expect(open).toHaveBeenCalledTimes(1);
    expect(inFlight).toEqual({ reservations: 1, budgets: 1, inflightSet: 1 });
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]); // 20: exactly one settlement removed the reservation
    expect(await redis().keys('test:ai:tool:*')).toEqual([]); // the budget is closed with the request

    // 6: Node signed BOTH tokens for this request (LAYER Node): lt + tl in the generate token, a tool:execute callback token with the same request id.
    expect(signGen).toHaveBeenCalledTimes(1);
    expect(signGen.mock.calls[0][0]).toMatchObject({ liveTools: true, userId: String(U.emp1._id), orgId: String(U.emp1.organization) });
    expect(signCb.mock.calls.map((c) => c[0].scopes)).toEqual([['tool:execute']]);
    expect(signCb.mock.calls[0][0].requestKey).toBe(signGen.mock.calls[0][0].requestKey);

    // 7-9: Python accepted both signals (it would have answered 401 otherwise) and called Groq with its own fixed tool list + rules (LAYER Python).
    expect(S.groq.requests).toHaveLength(2);
    const first = S.groq.requests[0];
    expect(first.tools.map((t) => t.function.name).sort()).toEqual(['get_project_overview', 'get_team', 'get_workload_summary', 'list_my_schedule', 'list_my_tasks', 'list_project_members', 'list_project_tasks', 'list_projects']);
    expect(first.messages[0].role).toBe('system');
    expect(first.messages[0].content).toMatch(/untrusted DATA/);
    expect(first.messages[1]).toMatchObject({ role: 'user' }); // (history is empty for a new conversation; the system prompt is first)

    // 10-12: Groq asked for list_projects; Python validated name+arguments and announced it BEFORE the callback (LAYER Python).
    const activity = result.events.filter((e) => e.type === 'tool_activity');
    expect(activity).toEqual([{ type: 'tool_activity', tool: 'list_projects' }]);
    expect(result.events.findIndex((e) => e.type === 'tool_activity')).toBeLessThan(result.events.findIndex((e) => e.type === 'text'));

    // 13-15: Node validated the activity event, re-authorized the callback (fresh user, AI + live data, permission, visibility) and ran the tool as emp1.
    const audit = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean();
    expect(audit.map((a) => [a.metadata.tool, a.metadata.status])).toEqual([['list_projects', 'success']]); // LAYER Node: audit of the callback
    // 16: Groq received the result as a TOOL message (untrusted data) and only what emp1 may see.
    const [tool] = S.toolResults(1);
    expect(tool).toMatchObject({ id: 'call_1', name: 'list_projects', status: 'ok' });
    const seen = JSON.stringify(tool);
    expect(seen).toContain('Apollo');
    expect(seen).toContain(S.F.projects.skunk.name); // emp1 OWNS the private project, so it is rightly visible to them
    expect(seen).not.toMatch(/Legacy|Gone|Zeus|Hades/); // archived / deleted / another organization's: absent

    // 17-19: final text, sanitized activity and usage over SSE; nothing internal reaches the browser.
    expect(types(result.events)).toEqual(['meta', 'tool_activity', 'text', 'text', 'usage', 'done']);
    expect(JSON.stringify(result.events)).not.toMatch(/call_1|tool_calls|arguments|Bearer|eyJ|test:ai|"limit"/);
    expect(result.events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('You can see 3 projects: Apollo and two others.');

    // 19-20 (saved): the conversation holds ONE user message and ONE assistant message with the final text only.
    const rows = await AiMessage.find({ conversation: result.conversationId }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => [r.role, r.status])).toEqual([['user', 'complete'], ['assistant', 'complete']]);
    expect(rows[1].content).toBe('You can see 3 projects: Apollo and two others.');
    expect(JSON.stringify(rows)).not.toMatch(/tool_activity|list_projects|call_1/);

    // 20: usage settled exactly once, to the sum of BOTH Groq rounds (1700+2100 in, 40+30 out), one durable event.
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await lastUsage()).toMatchObject({ status: 'success', inputTokens: 3800, outputTokens: 70, totalTokens: 3870, chargedTokens: 3870, tokensEstimated: false, toolCalls: 1, quotaSettled: true, streamStarted: true });
    expect((await counters('emp1')).userDailyUsed).toBe(3870);
    expect(S.py.logs).not.toMatch(/eyJ|How many projects|Apollo|gsk_/); // Python logs hold no token, prompt or result
    expect(S.allGroqText()).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no token reached the model
  }, 60000);
});

d('the paths that must stay separate and safe', () => {
  test('an organization WITHOUT live data stays on the DOCUMENT-ONLY path: no budget, no lt, no tools; (Python retrieval is off in this environment, so it is refused cleanly before any model call)', async () => {
    await AiOrgSettings.updateOne({ organization: S.F.orgA._id }, { liveDataEnabled: false });
    const open = jest.spyOn(toolBudget, 'openBudget');
    const signGen = jest.spyOn(tokens, 'signGenerateToken');
    const r = await S.chat('emp1', 'hi');
    expect(r.status).toBeGreaterThanOrEqual(500); // /answer answers RETRIEVAL_DISABLED: the document path cannot serve it here
    expect(open).not.toHaveBeenCalled();
    expect(signGen.mock.calls[0][0].liveTools).toBe(false);
    expect(S.groq.requests).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
  }, 60000);

  test('AI disabled: refused by Node before Python, Groq or any tool is touched', async () => {
    await AiOrgSettings.updateOne({ organization: S.F.orgA._id }, { enabled: false });
    const r = await S.chat('emp1', 'hi');
    expect([r.status]).not.toEqual([200]);
    expect(S.groq.requests).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
  }, 60000);

  test('the browser cannot turn tools on: the endpoint rejects any extra body field', async () => {
    const conv = await S.createConversation('emp1');
    for (const extra of [{ toolBudget: true }, { liveTools: true }, { tools: [{ name: 'list_projects' }] }, { lt: true }, { rag: false }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await as('emp1').post(`/api/v1/ai/conversations/${conv.id}/messages`).send({ content: 'hi', ...extra });
      expect(res.status).toBe(400);
    }
    expect(S.groq.requests).toHaveLength(0);
  }, 60000);

  test('RAG and the plain document-QA endpoint are untouched by the test activation harness for the production path', () => {
    const real = jest.requireActual('../../src/services/ai/rag/ask.service');
    expect(typeof real.streamAnswer).toBe('function'); // the production implementation still exists unchanged
    expect(String(real.streamAnswer)).toContain('rag:'); // ...and still sends a `rag` request (which the pipeline refuses to combine with a tool budget)
  });
});

d('usage accounting', () => {
  test('one reservation, one settlement, every Groq round counted, activity events add nothing', async () => {
    S.groq.queue(
      toolPlan([{ id: 'a', name: 'list_my_tasks' }, { id: 'b', name: 'get_team' }], { usage: USAGE(1000, 20) }),
      toolPlan([{ id: 'c', name: 'list_projects' }], { usage: USAGE(1500, 25) }),
      textPlan('done', { usage: USAGE(1800, 30) }),
    );
    const r = await S.chat('emp1', 'tell me everything');
    expect(types(r.events).filter((t) => t === 'tool_activity')).toHaveLength(3); // three announcements...
    expect(await lastUsage()).toMatchObject({ status: 'success', inputTokens: 4300, outputTokens: 75, totalTokens: 4375, chargedTokens: 4375, toolCalls: 3, tokensEstimated: false }); // ...which cost nothing
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect((await counters('emp1')).userDailyUsed).toBe(4375);
    expect((await counters('emp1')).orgMonthlyUsed).toBe(4375);
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
  }, 60000);

  test('tool callbacks themselves add no token usage; failed callbacks are counted as failures, not tokens', async () => {
    jest.spyOn(aiScope, 'resolveAiScope').mockRejectedValue(Object.assign(new Error('x'), { code: 'SOMETHING' })); // every tool fails
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }], { usage: USAGE(900, 10) }), textPlan('could not', { usage: USAGE(1000, 12) }));
    await S.chat('emp1', 'projects?');
    expect(await lastUsage()).toMatchObject({ status: 'success', inputTokens: 1900, outputTokens: 22, chargedTokens: 1922, toolCalls: 1, toolFailures: 1 });
  }, 60000);

  test('the reservation covers the tool definitions Python adds, and pricing stays Node-authoritative', async () => {
    S.groq.queue(textPlan('hi', { usage: USAGE(2000, 10) }));
    await S.chat('emp1', 'hi');
    const ev = await lastUsage();
    expect(ev.reservedTokens).toBeGreaterThanOrEqual(4 * 1800); // (rounds+1) calls x >= 1.8k tokens of definitions + rules
    expect(ev.estimatedCostMicros).toBe(estimateCostMicros('openai/gpt-oss-120b', 2000, 10)); // computed by Node from the reported tokens
  }, 60000);

  test('quota exhaustion stops the request BEFORE Python, Groq or any tool', async () => {
    await AiOrgSettings.updateOne({ organization: S.F.orgA._id }, { quotas: { userDailyTokens: 500 } });
    const r = await S.chat('emp1', 'hi');
    expect([413, 429]).toContain(r.status); // a quota refusal (too large for the remaining budget / exhausted), never a 200
    expect(JSON.stringify(r.body)).toMatch(/AI_QUOTA/);
    expect(S.groq.requests).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
    expect(await lastUsage()).toMatchObject({ status: 'denied', chargedTokens: 0 });
    expect(await redis().keys('test:ai:tool:*')).toEqual([]); // no budget was left open
  }, 60000);

  test('Groq failing AFTER a successful tool round: the spent round is charged and flagged real (Python reports it before the error)', async () => {
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }], { usage: USAGE(1700, 40) }), { status: 500, body: { error: { message: 'boom' } } });
    const r = await S.chat('emp1', 'projects?');
    expect(types(r.events)).toContain('error');
    expect(await lastUsage()).toMatchObject({ status: 'error', inputTokens: 1700, outputTokens: 40, chargedTokens: 1740, tokensEstimated: false, toolCalls: 1 });
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
  }, 60000);

  test('a retried Groq tool_use_failed is not double counted (the failed generation reports no usage)', async () => {
    S.groq.queue({ status: 400, body: { error: { message: 'Failed to call a function', type: 'invalid_request_error', code: 'tool_use_failed' } } }, toolPlan([{ id: 'a', name: 'list_projects' }], { usage: USAGE(1700, 40) }), textPlan('ok', { usage: USAGE(1800, 20) }));
    const r = await S.chat('emp1', 'projects?');
    expect(types(r.events)).toContain('done');
    expect(S.groq.requests).toHaveLength(3);
    expect(await lastUsage()).toMatchObject({ status: 'success', chargedTokens: 1700 + 40 + 1800 + 20 });
  }, 60000);

  test('settling the same request twice cannot happen (the reservation is gone after the first)', async () => {
    let reservation;
    const real = limits.settle;
    jest.spyOn(limits, 'settle').mockImplementation(async (args) => { reservation = args.reservation; return real(args); });
    S.groq.queue(textPlan('hi', { usage: USAGE(500, 5) }));
    await S.chat('emp1', 'hi');
    const before = await counters('emp1');
    expect(await real({ reservation, actual: 99999 })).toBe(false);
    expect(await counters('emp1')).toEqual(before);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  }, 60000);

  test('durable and attributable: the event carries the user, organization, feature, conversation and request key', async () => {
    S.groq.queue(textPlan('hi', { usage: USAGE(500, 5) }));
    const r = await S.chat('emp1', 'hi');
    const ev = await lastUsage();
    expect(String(ev.user)).toBe(String(users.emp1._id));
    expect(String(ev.organization)).toBe(String(users.emp1.organization));
    expect(ev.feature).toBe('tools');
    expect(String(ev.conversation)).toBe(String(r.conversationId));
    expect(typeof ev.requestKey).toBe('string');
    expect(ev.model).toBe('openai/gpt-oss-120b');
    expect(JSON.stringify(ev)).not.toMatch(/How|hi\b.*prompt|eyJ/); // no prompt, completion or token
  }, 60000);
});

d('the two documented accounting limitations are FIXED by cumulative snapshots (measured, real Python + real Node)', () => {
  test('cancelled after a Groq round finished but BEFORE the first tool callback: the completed round is now charged (it used to be 0)', async () => {
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_projects' }], { usage: USAGE(1700, 40) }), textPlan('never'));
    const slow = jest.spyOn(toolBudget, 'acquire').mockImplementation(() => new Promise(() => {})); // the callback never completes: Node never sees a tool call
    const chat = S.startChat('emp1', 'projects?');
    await S.until(() => S.groq.requests.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    chat.abort();
    await chat.done;
    await S.until(async () => (await AiUsageEvent.countDocuments()) === 1);
    slow.mockRestore();
    const ev = await lastUsage();
    expect(ev).toMatchObject({ status: 'cancelled', toolCalls: 0, totalTokens: 1740, chargedTokens: 1740, tokensEstimated: false }); // exactly what Groq reported
    expect((await counters('emp1')).userDailyUsed).toBe(1740);
  }, 60000);

  test('after SEVERAL rounds, a cancel is charged the TRUE cumulative spend, not an estimate of one round', async () => {
    const real = [USAGE(1700, 40), USAGE(2400, 40)];
    S.groq.queue(toolPlan([{ id: 'a', name: 'list_my_tasks' }], { usage: real[0] }), toolPlan([{ id: 'b', name: 'get_team' }], { usage: real[1] }), textPlan('never'));
    let calls = 0;
    const realAcquire = toolBudget.acquire;
    jest.spyOn(toolBudget, 'acquire').mockImplementation(async (a) => { calls += 1; if (calls >= 2) return new Promise(() => {}); return realAcquire(a); });
    const chat = S.startChat('emp1', 'tasks and team?');
    await S.until(() => S.groq.requests.length === 2);
    await new Promise((r) => setTimeout(r, 400));
    chat.abort();
    await chat.done;
    await S.until(async () => (await AiUsageEvent.countDocuments()) === 1);
    const ev = await lastUsage();
    const groqSpent = real.reduce((n, u) => n + u.total_tokens, 0);
    expect(ev).toMatchObject({ status: 'cancelled', tokensEstimated: false, chargedTokens: groqSpent, totalTokens: groqSpent });
    console.info(`[accounting] real Groq spend ${groqSpent} tokens; Node charged ${ev.chargedTokens} (the reported cumulative total)`);
  }, 60000);
});
