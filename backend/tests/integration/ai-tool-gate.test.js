jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/** Phase 8, Step 1: the hardened tool-callback gate. Only test tools are registered; no organizational data tool exists. */
const mongoose = require('mongoose');
const request = require('supertest');
const { z } = require('zod');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { PERMISSIONS: P } = require('../../src/constants/permissions');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const { clearTools, registerTool } = require('../../src/services/ai/aiToolRegistry');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const toolRuns = require('../../src/services/ai/tools/toolRuns');
const { forUser } = require('../../src/controllers/ai.controller');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const internal = createInternalApp();
const redis = () => createRedisClient();
const oid = () => new mongoose.Types.ObjectId();
const MESSAGES = [{ role: 'user', content: 'hi' }];
const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_TOOL_MAX_CALLS', 'AI_TOOL_MAX_CONCURRENT', 'AI_TOOL_TIMEOUT_MS', 'AI_TOOL_TOTAL_MS'];
const saved = {};
let orgA; let runs = []; let seen;

const post = (token, body) => {
  const req = request(internal).post('/internal/ai/tools/execute').send(body);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const call = (token, name, args = {}, callId = 'c1') => post(token, { callId, name, arguments: args });
// supertest requests are lazy: this one is sent NOW, so a test can act while it is in flight.
const callNow = (token, name, args = {}, callId = 'c1') => call(token, name, args, callId).then((r) => r);
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not reached in time');
};

async function startInFlight(actor, { toolBudget = true } = {}) {
  stub.enqueue({ frames: [{ type: 'text', text: 'hello' }], hangAfterFrames: true });
  const before = stub.requests.length;
  const controller = new AbortController();
  const run = (async () => {
    try {
      for await (const e of streamAiRequest({ actor, feature: 'tools', messages: MESSAGES, toolBudget, signal: controller.signal })) void e;
    } catch { /* abort at the end */ }
  })();
  runs.push({ controller, run });
  await until(() => stub.requests.length === before + 1);
  const requestKey = stub.requests[before].claims.jti;
  return {
    requestKey,
    token: tokens.signCallbackToken({ userId: actor._id.toString(), orgId: actor.organization.toString(), requestKey }),
    finish: async () => { controller.abort(); await run; },
  };
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await stub.start();
  for (const k of SAVE) saved[k] = env[k];
  aiService.resetEngine();
});
afterAll(async () => {
  Object.assign(env, saved);
  clearTools();
  await stub.stop();
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
afterEach(async () => {
  for (const { controller, run } of runs) {
    controller.abort();
    // eslint-disable-next-line no-await-in-loop
    await run;
  }
});
beforeEach(async () => {
  runs = [];
  seen = { started: 0, finished: 0, aborted: 0 };
  stub.reset();
  aiService.resetEngine();
  Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_GLOBAL_ENABLED: true, AI_TOOL_MAX_CALLS: 5, AI_TOOL_MAX_CONCURRENT: 2, AI_TOOL_TIMEOUT_MS: 8000, AI_TOOL_TOTAL_MS: 20000 });
  clearTools();
  const obj = (shape) => z.object(shape).strict();
  const base = { kind: 'read', permission: P.USE_AI };
  registerTool({ ...base, name: 'quick', schema: obj({ q: z.string().max(40).optional(), n: z.number().optional() }), resultSchema: obj({ ok: z.boolean() }), auditFields: ['n'], run: async () => { seen.started += 1; return { ok: true }; } });
  registerTool({
    ...base, name: 'slow', schema: obj({ ms: z.number() }), resultSchema: obj({ done: z.boolean() }), auditFields: ['ms'],
    run: ({ input, signal }) => new Promise((resolve) => {
      seen.started += 1;
      const t = setTimeout(() => { seen.finished += 1; resolve({ done: true }); }, input.ms);
      signal.addEventListener('abort', () => { clearTimeout(t); seen.aborted += 1; resolve({ done: false }); }, { once: true });
    }),
  });
  registerTool({ ...base, name: 'deaf', schema: obj({}), resultSchema: obj({ done: z.boolean() }), run: () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 1500)) }); // ignores the signal
  registerTool({ ...base, name: 'leaky', schema: obj({}), resultSchema: obj({ title: z.string() }), run: async () => ({ title: 'ok', description: 'SECRET-DESCRIPTION' }) });
  registerTool({ ...base, name: 'rawdoc', schema: obj({}), resultSchema: z.any(), run: async () => ({ id: new mongoose.Types.ObjectId(), at: new Date() }) });
  registerTool({ ...base, name: 'many', schema: obj({}), resultSchema: z.any(), run: async () => ({ rows: Array.from({ length: 60 }, (_, i) => i) }) });
  registerTool({ ...base, name: 'heavy', schema: obj({}), resultSchema: z.any(), run: async () => ({ rows: Array.from({ length: 40 }, () => 'x'.repeat(190)) }) });
  registerTool({ ...base, name: 'sensitive', schema: obj({}), resultSchema: z.any(), run: async () => ({ email: 'a@b.c' }) });
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings.deleteMany({}), AiUsageEvent.deleteMany({}), AuditLog.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await AiOrgSettings.create({ organization: orgA._id, enabled: true, liveDataEnabled: true });
});

describe('the live-data flag is checked on every callback', () => {
  test('with live data OFF nothing runs, and the refusal is audited (a budget cannot even be opened for such an organization; here it is switched off right after the request started)', async () => {
    const live = await startInFlight(users.emp);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { liveDataEnabled: false });
    const res = await call(live.token, 'quick');
    expect([res.status, res.body.code]).toEqual([403, 'AI_LIVE_DATA_DISABLED']);
    expect(seen.started).toBe(0);
  });

  test('switching it off mid-conversation stops the NEXT tool execution', async () => {
    const live = await startInFlight(users.emp);
    expect((await call(live.token, 'quick', { n: 1 })).status).toBe(200);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { liveDataEnabled: false });
    const res = await call(live.token, 'quick', { n: 2 });
    expect([res.status, res.body.code]).toEqual([403, 'AI_LIVE_DATA_DISABLED']);
    expect(seen.started).toBe(1);
  });

  test('switching it off WHILE a tool runs discards that tool\'s result', async () => {
    const live = await startInFlight(users.emp);
    const pending = callNow(live.token, 'slow', { ms: 400 });
    await until(() => seen.started === 1);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { liveDataEnabled: false });
    const res = await pending;
    expect([res.status, res.body.code]).toEqual([403, 'AI_LIVE_DATA_DISABLED']);
    expect(res.body.result).toBeUndefined();
  });

  test('AI off, a blocked user, or a role without USE_AI each stop the next callback', async () => {
    const live = await startInFlight(users.emp);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    expect((await call(live.token, 'quick')).body.code).toBe('AI_DISABLED');
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: true });
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: true });
    expect((await call(live.token, 'quick')).status).toBe(401);
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: false, role: ROLES.GUEST });
    expect((await call(live.token, 'quick')).status).toBe(403);
  });
});

describe('a tool budget is mandatory', () => {
  test('a request Node did not open a tool budget for cannot run any tool, and looks exactly like an unknown tool', async () => {
    const live = await startInFlight(users.emp, { toolBudget: false });
    const noBudget = await call(live.token, 'quick');
    const unknown = await call(live.token, 'no_such_tool');
    expect([noBudget.status, noBudget.body.code]).toEqual([404, 'AI_TOOL_NOT_FOUND']);
    expect({ ...noBudget.body, stack: undefined }).toEqual({ ...unknown.body, stack: undefined });
    expect(seen.started).toBe(0);
  });

  test('the budget is closed when the request ends: the key is gone and the token is dead', async () => {
    const live = await startInFlight(users.emp);
    await call(live.token, 'quick').expect(200);
    expect((await redis().keys('test:ai:tool:*')).length).toBe(1);
    await live.finish();
    expect(await redis().keys('test:ai:tool:*')).toEqual([]);
    expect((await call(live.token, 'quick', { n: 9 })).status).toBe(401);
  });
});

describe('per-request limits', () => {
  test('at most AI_TOOL_MAX_CALLS executions per request', async () => {
    env.AI_TOOL_MAX_CALLS = 2;
    const live = await startInFlight(users.emp);
    expect((await call(live.token, 'quick', { n: 1 })).status).toBe(200);
    expect((await call(live.token, 'quick', { n: 2 })).status).toBe(200);
    const third = await call(live.token, 'quick', { n: 3 });
    expect([third.status, third.body.code]).toEqual([429, 'AI_TOOL_BUDGET']);
    expect(seen.started).toBe(2);
  });

  test('the same call (arguments in any order) runs once; a different call is fine', async () => {
    const live = await startInFlight(users.emp);
    expect((await call(live.token, 'quick', { q: 'a', n: 1 })).status).toBe(200);
    const again = await call(live.token, 'quick', { n: 1, q: 'a' });
    expect([again.status, again.body.code]).toEqual([409, 'AI_TOOL_DUPLICATE']);
    expect((await call(live.token, 'quick', { q: 'b', n: 1 })).status).toBe(200);
    expect(seen.started).toBe(2);
  });

  test('concurrency is capped; the slot comes back when the running call ends', async () => {
    env.AI_TOOL_MAX_CONCURRENT = 1;
    const live = await startInFlight(users.emp);
    const first = callNow(live.token, 'slow', { ms: 300 });
    await until(() => seen.started === 1);
    const second = await call(live.token, 'quick', { n: 1 });
    expect([second.status, second.body.code]).toEqual([429, 'AI_TOOL_CONCURRENCY']);
    expect((await first).status).toBe(200);
    expect((await call(live.token, 'quick', { n: 2 })).status).toBe(200);
  });

  test('total tool time is capped: once spent, no new call may start', async () => {
    env.AI_TOOL_TOTAL_MS = 100;
    const live = await startInFlight(users.emp);
    // the deadline of a call shrinks to the time the request has left, so this one is cut off at ~100 ms and spends it all
    const first = await call(live.token, 'slow', { ms: 3000 });
    expect([first.status, first.body.code]).toEqual([504, 'AI_TOOL_TIMEOUT']);
    const third = await call(live.token, 'quick', { n: 1 });
    expect([third.status, third.body.code]).toEqual([429, 'AI_TOOL_BUDGET']);
  });

  test('one execution has a deadline: it is aborted, the tool sees the abort, and the caller gets a fixed timeout error', async () => {
    env.AI_TOOL_TIMEOUT_MS = 100;
    const live = await startInFlight(users.emp);
    const res = await call(live.token, 'slow', { ms: 3000 });
    expect([res.status, res.body.code]).toEqual([504, 'AI_TOOL_TIMEOUT']);
    expect(seen.aborted).toBe(1);
    expect(toolRuns.activeCount()).toBe(0);
  });

  test('even a tool that ignores the signal cannot hold the callback past the deadline', async () => {
    env.AI_TOOL_TIMEOUT_MS = 100;
    const live = await startInFlight(users.emp);
    const t = Date.now();
    const res = await call(live.token, 'deaf');
    expect(res.body.code).toBe('AI_TOOL_TIMEOUT');
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('cancellation reaches the running tool', () => {
  test('when the REQUEST ends (user stopped it) every tool still running for it is aborted', async () => {
    const live = await startInFlight(users.emp);
    const pending = callNow(live.token, 'slow', { ms: 5000 });
    await until(() => seen.started === 1);
    await live.finish();
    const res = await pending;
    expect(res.body.code).toBe('AI_TOOL_ABORTED');
    expect(seen.aborted).toBe(1);
    expect(toolRuns.activeCount()).toBe(0);
  });

  test('when the CALLER goes away (Python cancelled) the tool run is aborted, not finished', async () => {
    const live = await startInFlight(users.emp);
    const req = post(live.token, { callId: 'c', name: 'slow', arguments: { ms: 5000 } });
    req.then(() => {}, () => {});
    await until(() => seen.started === 1);
    req.abort();
    await until(() => seen.aborted === 1);
    await until(() => toolRuns.activeCount() === 0);
    expect(seen.finished).toBe(0);
  });
});

describe('results: allowlist, plain data, limits', () => {
  test('a field outside the tool\'s allowlist fails the call and nothing of it is returned', async () => {
    const live = await startInFlight(users.emp);
    const res = await call(live.token, 'leaky');
    expect([res.status, res.body.code]).toEqual([502, 'AI_TOOL_RESULT_INVALID']);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-DESCRIPTION|description/);
  });

  test('raw database values, over-long arrays, over-size results and sensitive keys are refused', async () => {
    const live = await startInFlight(users.emp);
    expect((await call(live.token, 'rawdoc')).body.code).toBe('AI_TOOL_RESULT_INVALID');
    expect((await call(live.token, 'many')).body.code).toBe('AI_TOOL_RESULT_TOO_LARGE');
    expect((await call(live.token, 'heavy')).body.code).toBe('AI_TOOL_RESULT_TOO_LARGE');
    expect((await call(live.token, 'sensitive')).body.code).toBe('AI_TOOL_RESULT_INVALID');
  });
});

describe('audit', () => {
  test('every identified call is audited, success and refusal, with counts and safe arguments only', async () => {
    const live = await startInFlight(users.emp);
    await call(live.token, 'quick', { q: 'SECRET QUESTION TEXT', n: 7 }, 'ok-1').expect(200);
    await call(live.token, 'quick', { q: 'SECRET QUESTION TEXT', n: 7 }, 'dup-1'); // duplicate
    await call(live.token, 'quick', { n: 'not a number' }, 'bad-1'); // bad arguments
    await call(live.token, 'leaky', {}, 'leak-1'); // result refused
    await call(live.token, 'nope', {}, 'nf-1'); // unknown tool
    const rows = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.metadata.callId, r.metadata.status, r.metadata.errorCode])).toEqual([
      ['ok-1', 'success', null], ['dup-1', 'refused', 'AI_TOOL_DUPLICATE'], ['bad-1', 'refused', 'AI_TOOL_BAD_ARGUMENTS'], ['leak-1', 'refused', 'AI_TOOL_RESULT_INVALID'], ['nf-1', 'refused', 'AI_TOOL_NOT_FOUND'],
    ]);
    expect(rows[0]).toMatchObject({ organization: orgA._id, user: users.emp._id, entityType: 'ai_tool', success: true });
    expect(rows[0].metadata).toMatchObject({ tool: 'quick', requestKey: live.requestKey, records: 0, args: { n: 7 }, argKeys: ['q', 'n'] });
    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/SECRET QUESTION TEXT|SECRET-DESCRIPTION/); // free text and results never reach the audit log
  });

  test('a call with a bad token cannot be attributed and writes no row', async () => {
    await call('garbage', 'quick').expect(401);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
  });
});

describe('usage and quota', () => {
  test('usage records how many tool calls ran and how long, with no content', async () => {
    const live = await startInFlight(users.emp);
    await call(live.token, 'quick', { n: 1 }).expect(200);
    await call(live.token, 'slow', { ms: 60 }).expect(200);
    await call(live.token, 'leaky').catch(() => {});
    await live.finish();
    await until(async () => (await AiUsageEvent.countDocuments({ requestKey: live.requestKey })) === 1);
    const row = await AiUsageEvent.findOne({ requestKey: live.requestKey }).lean();
    expect(row).toMatchObject({ toolCalls: 3, toolFailures: 1 });
    expect(row.toolMs).toBeGreaterThanOrEqual(60);
  });

  test('a tool-capable request reserves its bounded worst case up front; a plain request is unchanged', async () => {
    const plain = await startInFlight(users.emp, { toolBudget: false });
    await plain.finish();
    const tools = await startInFlight(users.emp);
    await tools.finish();
    await until(async () => (await AiUsageEvent.countDocuments()) === 2);
    const a = await AiUsageEvent.findOne({ requestKey: plain.requestKey }).lean();
    const b = await AiUsageEvent.findOne({ requestKey: tools.requestKey }).lean();
    const results = env.AI_TOOL_MAX_CALLS * Math.ceil(env.AI_TOOL_MAX_RESULT_BYTES / 4);
    expect(b.reservedTokens).toBeGreaterThanOrEqual(a.reservedTokens + env.AI_TOOL_MAX_ROUNDS * results);
    expect(a.toolCalls).toBe(0);
  });
});

describe('what a browser may ever receive', () => {
  test('forUser is a whitelist: raw tool events and unknown events are dropped, known ones are rebuilt field by field', () => {
    expect(forUser({ type: 'tool_calls', calls: [{ name: 'x', arguments: '{"secret":1}' }] })).toBeNull();
    expect(forUser({ type: 'internal_debug', prompt: 'SYSTEM PROMPT' })).toBeNull();
    expect(forUser({ type: 'text', text: 'hi', leaked: 'SECRET' })).toEqual({ type: 'text', text: 'hi' });
    expect(forUser({ type: 'usage', inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false, requestId: 'r' })).toEqual({ type: 'usage', inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false });
    expect(forUser({ type: 'retrieval', used: 2, rejected: 9 })).toEqual({ type: 'retrieval', sourcesUsed: 2 });
    expect(forUser({ type: 'done', finishReason: 'stop', model: 'm' })).toEqual({ type: 'done', finishReason: 'stop' });
  });
});
