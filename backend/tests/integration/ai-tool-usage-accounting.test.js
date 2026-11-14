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
 * Phase 8 Step 6A: usage accounting of a TOOL-CAPABLE request (several model rounds, tool callbacks in between).
 * Node stays authoritative: Python only reports usage frames; Node reserves, settles once, and records one durable event.
 * The engine here is a stand-in that really executes tool budget calls (acquire/release) like the callback gate does.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { make } = require('../../src/services/ai/aiService/errors');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const aiService = require('../../src/services/ai/aiService');
const registry = require('../../src/services/ai/aiToolRegistry');
const toolBudget = require('../../src/services/ai/tools/toolBudget.service');
const { registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { resolveToolLimits, limitsClaim } = require('../../src/services/ai/tools/toolLimits');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const MESSAGES = [{ role: 'user', content: 'PROMPT-SECRET how many projects?' }];
const TZ = 'Asia/Kolkata';
const ids = () => ({ orgId: users.emp.organization.toString(), userId: users.emp._id.toString() });
const counters = () => limits.readCounters({ ...ids(), timeZone: TZ });
const lastEvent = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not reached in time');
};
const done = (extra = {}) => ({ type: 'done', finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'r1', firstEventMs: 5, ...extra });
const usage = (i, o) => ({ type: 'usage', inputTokens: i, outputTokens: o, totalTokens: i + o, estimated: false });

/** An engine that behaves like Python's tool loop. `script(ctl)` decides what happens; `ctl.runTool()` is a real tool-budget execution. */
function engine(script) {
  const calls = [];
  return {
    name: 'scripted', calls,
    async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 't', replayStore: 'memory' }; },
    async *chat(params) {
      calls.push(params);
      const { orgId, requestKey } = params.identity;
      const ctl = {
        params,
        async runTool(input = { n: Math.random() }) {
          await toolBudget.acquire({ orgId, requestKey, name: 'list_projects', input });
          await toolBudget.release({ orgId, requestKey, ms: 5, failed: false });
        },
        hang: () => new Promise((resolve) => { if (params.signal?.aborted) resolve(); else params.signal?.addEventListener('abort', resolve, { once: true }); }),
      };
      yield* script(ctl);
    },
  };
}
const run = async (options = {}, controller = new AbortController()) => {
  const events = [];
  try {
    for await (const e of streamAiRequest({ actor: users.emp, feature: 'tools', messages: MESSAGES, toolBudget: true, signal: controller.signal, ...options })) events.push(e);
  } catch (error) {
    return { error, events };
  }
  return { events };
};

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
});
afterAll(async () => {
  aiService.resetEngine();
  registry.clearTools();
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  Object.assign(env, { AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100, AI_REQUEST_CEILING_MS: 120000 });
  registry.clearTools();
  registerLiveDataTools();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
  const org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await AiOrgSettings.create({ organization: org._id, enabled: true, liveDataEnabled: true });
});

describe('where tokens are accumulated, and what is charged', () => {
  test('success: Python sums every model round into ONE usage frame; Node charges exactly that and settles once', async () => {
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.runTool();
      yield { type: 'text', text: 'You have 3.' };
      yield usage(3400, 120); // round 1 + round 2, as Python sums them
      yield done();
    }));
    const { events } = await run();
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    const ev = await lastEvent();
    expect(ev).toMatchObject({ status: 'success', inputTokens: 3400, outputTokens: 120, totalTokens: 3520, chargedTokens: 3520, tokensEstimated: false, toolCalls: 1, quotaSettled: true });
    expect((await counters()).userDailyUsed).toBe(3520); // the reservation was REPLACED by the charge, not added to it
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
  });

  test('a tool call that FAILED does not change what the model rounds cost', async () => {
    aiService.setEngine(engine(async function* (ctl) {
      await toolBudget.acquire({ orgId: ctl.params.identity.orgId, requestKey: ctl.params.identity.requestKey, name: 'list_projects', input: { a: 1 } });
      await toolBudget.release({ orgId: ctl.params.identity.orgId, requestKey: ctl.params.identity.requestKey, ms: 5, failed: true });
      yield { type: 'text', text: 'I could not retrieve that.' };
      yield usage(3000, 40);
      yield done();
    }));
    await run();
    expect(await lastEvent()).toMatchObject({ status: 'success', chargedTokens: 3040, toolCalls: 1, toolFailures: 1 });
  });

  test('Groq failing AFTER earlier rounds: Python reports the usage first, so those tokens are charged (not zero)', async () => {
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.runTool();
      yield usage(1700, 60); // what the finished round(s) really cost
      throw make(C.UNAVAILABLE, { streamStarted: false });
    }));
    const { error } = await run();
    expect(error.code).toBe(C.UNAVAILABLE);
    expect(await lastEvent()).toMatchObject({ status: 'error', chargedTokens: 1760, tokensEstimated: false, toolCalls: 1 });
    expect((await counters()).userDailyUsed).toBe(1760);
  });
});

describe('the gap that existed: a tool-enabled request that ends without a usage frame', () => {
  test('cancelled after a tool ran, no usage frame: charged an ESTIMATE (it used to settle at zero)', async () => {
    const controller = new AbortController();
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.runTool(); // round 1 finished and was paid for; the tool ran
      await ctl.hang(); // the browser closes
      throw make(C.ABORTED);
    }));
    const pending = run({}, controller);
    await waitFor(async () => (await redis().keys('test:ai:tb:*')).length > 0 || true);
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    const { error } = await pending;
    expect(error.code).toBe(C.ABORTED);
    const ev = await lastEvent();
    expect(ev).toMatchObject({ status: 'cancelled', toolCalls: 1, tokensEstimated: true });
    expect(ev.chargedTokens).toBeGreaterThan(0);
    expect(ev.chargedTokens).toBeLessThanOrEqual(ev.reservedTokens);
    expect((await counters()).userDailyUsed).toBe(ev.chargedTokens); // settled once, to the estimate
  });

  test('Groq error after a tool ran and no usage frame arrived (usage hop lost): estimate, flagged', async () => {
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.runTool();
      throw make(C.SERVICE_UNAVAILABLE, { streamStarted: false });
    }));
    await run();
    const ev = await lastEvent();
    expect(ev).toMatchObject({ status: 'error', tokensEstimated: true, toolCalls: 1 });
    expect(ev.chargedTokens).toBeGreaterThan(0);
  });

  test('cancelled BEFORE any tool ran (nothing proves a round finished): still zero, exactly as for a plain request', async () => {
    const controller = new AbortController();
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.hang();
      throw make(C.ABORTED);
    }));
    const pending = run({}, controller);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pending;
    expect(await lastEvent()).toMatchObject({ status: 'cancelled', chargedTokens: 0, toolCalls: 0 });
    expect((await counters()).userDailyUsed).toBe(0);
  });

  test('a request WITHOUT a tool budget is charged exactly as before (no new rule applies)', async () => {
    const controller = new AbortController();
    aiService.setEngine(engine(async function* (ctl) {
      await ctl.hang();
      throw make(C.ABORTED);
    }));
    const pending = run({ toolBudget: false }, controller);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pending;
    expect(await lastEvent()).toMatchObject({ status: 'cancelled', chargedTokens: 0 });
  });
});

describe('settlement cannot happen twice, and the reservation covers what Python adds', () => {
  test('settling the same reservation again is a no-op: no double charge, no double refund', async () => {
    let reservation;
    const real = limits.settle;
    jest.spyOn(limits, 'settle').mockImplementation(async (args) => { reservation = args.reservation; return real(args); });
    aiService.setEngine(engine(async function* () {
      yield { type: 'text', text: 'ok' };
      yield usage(500, 50);
      yield done();
    }));
    await run();
    const before = await counters();
    const again = await real({ reservation, actual: 99999 }); // a duplicate / late settle for the same request
    expect(again).toBe(false); // the reservation is already gone: nothing to settle
    expect(await counters()).toEqual(before);
    expect(await AiUsageEvent.countDocuments()).toBe(1); // one durable record per request
  });

  test('the up-front reservation of a tool-capable request includes the tool definitions Python adds (it did not before)', async () => {
    aiService.setEngine(engine(async function* () {
      yield { type: 'text', text: 'ok' };
      yield usage(10, 5);
      yield done();
    }));
    await run({ toolBudget: false });
    const plain = (await lastEvent()).reservedTokens;
    await run({ toolBudget: true });
    const withTools = (await lastEvent()).reservedTokens;
    const l = resolveToolLimits();
    // 4 model calls each re-read >= ~1.8k tokens of definitions + rules
    expect(withTools - plain).toBeGreaterThanOrEqual((l.maxRounds + 1) * 1800);
  });

  test('Python cannot write usage: the only way tokens reach the ledger is a usage FRAME Node meters (no endpoint exists)', () => {
    const { execSync } = require('child_process');
    const root = require('path').resolve(__dirname, '../..');
    const hits = execSync("grep -rln \"AiUsageEvent\\|recordUsage\" src/internalApp.js src/services/ai/aiCallbacks.service.js || true", { cwd: root }).toString().trim();
    expect(hits).toBe('');
  });
});

describe('Node limits travel with the request (claim tl) and an inconsistent configuration refuses to run', () => {
  const save = {};
  const keys = ['AI_TOOL_TIMEOUT_MS', 'AI_TOOL_TOTAL_MS', 'AI_TOOL_MAX_CALLS', 'AI_TOOL_MAX_CONCURRENT', 'AI_REQUEST_CEILING_MS'];
  beforeEach(() => keys.forEach((k) => { save[k] = env[k]; }));
  afterEach(() => Object.assign(env, save));

  test('limitsClaim mirrors the resolved limits and the request ceiling', () => {
    expect(limitsClaim()).toEqual({ r: env.AI_TOOL_MAX_ROUNDS, c: env.AI_TOOL_MAX_CALLS, k: env.AI_TOOL_MAX_CONCURRENT, t: env.AI_TOOL_TIMEOUT_MS, m: env.AI_TOOL_TOTAL_MS, b: env.AI_TOOL_MAX_RESULT_BYTES, d: env.AI_REQUEST_CEILING_MS });
  });

  test('a per-call limit above the total tool time is sent as the total (a call can never outlive the budget)', () => {
    Object.assign(env, { AI_TOOL_TIMEOUT_MS: 30000, AI_TOOL_TOTAL_MS: 20000 });
    expect(limitsClaim()).toMatchObject({ t: 20000, m: 20000 });
  });

  test.each([
    ['more in flight than calls allowed', { AI_TOOL_MAX_CONCURRENT: 9, AI_TOOL_MAX_CALLS: 3 }],
    ['tool time that does not fit inside the request ceiling', { AI_TOOL_TOTAL_MS: 115000, AI_REQUEST_CEILING_MS: 120000 }],
  ])('%s -> no claim can be minted (the request fails closed before Groq)', (_label, patch) => {
    Object.assign(env, patch);
    expect(() => limitsClaim()).toThrow('inconsistent');
    const tokens = require('../../src/services/ai/aiService/tokens');
    const pair = require('../helpers/stubAiService').createKeyPair();
    Object.assign(env, { AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1' });
    expect(() => tokens.signGenerateToken({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: 'r'.repeat(12), maxOutputTokens: 10, liveTools: true })).toThrow('inconsistent');
    expect(() => tokens.signGenerateToken({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: 'r'.repeat(12), maxOutputTokens: 10 })).not.toThrow(); // plain requests are unaffected
  });
});
