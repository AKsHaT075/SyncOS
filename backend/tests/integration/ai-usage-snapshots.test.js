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
 * Step 8A: CUMULATIVE usage snapshots. Python reports, after every completed model round, everything Groq has reported so far; Node keeps the latest
 * valid snapshot and never adds them. The engine here is a stand-in that really runs tool-budget calls, like the callback gate.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const { make } = require('../../src/services/ai/aiService/errors');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const aiService = require('../../src/services/ai/aiService');
const client = require('../../src/services/ai/aiService/client');
const registry = require('../../src/services/ai/aiToolRegistry');
const toolBudget = require('../../src/services/ai/tools/toolBudget.service');
const { registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const MSGS = [{ role: 'user', content: 'hi' }];
const snap = (total, input = Math.round(total * 0.9), estimated = false) => ({ type: 'usage', inputTokens: input, outputTokens: total - input, totalTokens: total, estimated });
const done = { type: 'done', finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'r', firstEventMs: 1 };
const lastEvent = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];
const counters = () => limits.readCounters({ orgId: String(users.emp.organization), userId: String(users.emp._id), timeZone: 'Asia/Kolkata' });
const settledAll = async () => { for (let i = 0; i < 100; i += 1) { if ((await AiUsageEvent.countDocuments()) === 1 && (await redis().keys('test:ai:q:*:r:*')).length === 0) return; await new Promise((r) => setTimeout(r, 20)); } };

/** An engine that plays `script(ctl)`; ctl.runTool() performs a real tool-budget execution; ctl.hang() waits for the abort. */
function engine(script) {
  return {
    name: 'scripted',
    async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 't', replayStore: 'memory' }; },
    async* chat(params) {
      const { orgId, requestKey } = params.identity;
      const ctl = {
        async runTool(input = { n: Math.random() }, failed = false) {
          await toolBudget.acquire({ orgId, requestKey, name: 'list_projects', input });
          await toolBudget.release({ orgId, requestKey, ms: 5, failed });
        },
        hang: () => new Promise((resolve) => { if (params.signal?.aborted) resolve(); else params.signal?.addEventListener('abort', resolve, { once: true }); }),
      };
      yield* script(ctl);
    },
  };
}
const run = async (options = {}, controller = new AbortController()) => {
  const events = [];
  try { for await (const e of streamAiRequest({ actor: users.emp, feature: 'tools', messages: MSGS, toolBudget: true, signal: controller.signal, ...options })) events.push(e); } catch (error) { return { error, events }; }
  return { events };
};
const play = (script, options) => { aiService.setEngine(engine(script)); return run(options); };

beforeAll(async () => { await connectTestDb(); await connectRedis(); });
afterAll(async () => {
  aiService.resetEngine(); registry.clearTools();
  await hub.shutdown();
  const keys = await redis().keys('test:ai*'); if (keys.length) await redis().del(keys);
  await disconnectTestDb(); await redis().quit();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  Object.assign(env, { AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100, AI_REQUEST_CEILING_MS: 120000 });
  registry.clearTools(); registerLiveDataTools();
  const keys = await redis().keys('test:ai:*'); if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
  const org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await AiOrgSettings.create({ organization: org._id, enabled: true, liveDataEnabled: true });
});

describe('the snapshot rules', () => {
  test('1,000 -> 2,400 -> 4,180 settles at 4,180 (the latest), NOT 7,580 (the sum); one settlement, one durable event', async () => {
    const r = await play(async function* (ctl) {
      yield snap(1000); await ctl.runTool();
      yield snap(2400); await ctl.runTool();
      yield { type: 'text', text: 'answer' };
      yield snap(4180);
      yield done;
    });
    expect(r.error).toBeUndefined();
    await settledAll();
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await lastEvent()).toMatchObject({ status: 'success', totalTokens: 4180, chargedTokens: 4180, toolCalls: 2, tokensEstimated: false, quotaSettled: true });
    expect((await counters()).userDailyUsed).toBe(4180);
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
  });

  test('the browser gets ONE final cumulative usage event (right before done), never the intermediate snapshots', async () => {
    const r = await play(async function* (ctl) { yield snap(1000); await ctl.runTool(); yield snap(2400); yield { type: 'text', text: 'a' }; yield snap(4180); yield done; });
    expect(r.events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    expect(r.events[1]).toMatchObject({ totalTokens: 4180 });
  });

  test('a DUPLICATED snapshot does not increase usage (idempotent)', async () => {
    await play(async function* () { yield snap(1000); yield snap(2400); yield snap(2400); yield snap(2400); yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ totalTokens: 2400, chargedTokens: 2400 });
  });

  test('a DECREASING snapshot is ignored: the latest valid snapshot stands', async () => {
    await play(async function* () { yield snap(4180); yield snap(2400); yield { ...snap(5000), inputTokens: 100, outputTokens: 4900 }; yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    // 2,400 is lower; the third has a LOWER input count (100 < 3762) even though its total is higher: also refused
    expect(await lastEvent()).toMatchObject({ totalTokens: 4180, chargedTokens: 4180 });
  });

  test.each([
    ['negative', { type: 'usage', inputTokens: -5, outputTokens: 10, totalTokens: 5, estimated: false }],
    ['fractional', { type: 'usage', inputTokens: 10.5, outputTokens: 10, totalTokens: 21, estimated: false }],
    ['a string count', { type: 'usage', inputTokens: '100', outputTokens: 10, totalTokens: 110, estimated: false }],
    ['NaN', { type: 'usage', inputTokens: NaN, outputTokens: 10, totalTokens: 10, estimated: false }],
    ['absurdly large', { type: 'usage', inputTokens: 9e15, outputTokens: 10, totalTokens: 9e15, estimated: false }],
    ['total smaller than its parts', { type: 'usage', inputTokens: 500, outputTokens: 500, totalTokens: 100, estimated: false }],
    ['missing fields', { type: 'usage' }],
  ])('a MALFORMED snapshot (%s) is ignored and never replaces a valid one', async (_label, bad) => {
    await play(async function* () { yield snap(1000); yield bad; yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ totalTokens: 1000, chargedTokens: 1000 });
  });

  test('a malformed snapshot BEFORE any valid one stores nothing (no usage is invented)', async () => {
    await play(async function* () { yield { type: 'usage', inputTokens: -1, outputTokens: 0, totalTokens: -1, estimated: false }; yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    const ev = await lastEvent();
    expect(ev.status).toBe('success');
    expect(ev.tokensEstimated).toBe(true); // no valid usage at all: the existing flagged estimate, not a made-up "real" number
  });

  test('estimated snapshots stay flagged', async () => {
    await play(async function* () { yield snap(1000, 900, true); yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ chargedTokens: 1000, tokensEstimated: true });
  });
});

describe('the latest valid snapshot survives every way a request can end', () => {
  test('a LATER snapshot lost (only the first two arrived, then the stream died): settles at the last one received', async () => {
    const r = await play(async function* (ctl) { yield snap(1000); await ctl.runTool(); yield snap(2400); throw make(C.SERVICE_UNAVAILABLE, { streamStarted: false }); });
    expect(r.error.code).toBe(C.SERVICE_UNAVAILABLE);
    await settledAll();
    expect(await lastEvent()).toMatchObject({ status: 'error', totalTokens: 2400, chargedTokens: 2400, tokensEstimated: false });
  });

  test('cancellation AFTER a completed round but BEFORE any tool callback: the round that completed is charged (this used to be 0)', async () => {
    const controller = new AbortController();
    aiService.setEngine(engine(async function* (ctl) { yield snap(1740); await ctl.hang(); throw make(C.ABORTED); }));
    const running = run({}, controller);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await running;
    await settledAll();
    const ev = await lastEvent();
    expect(ev).toMatchObject({ status: 'cancelled', toolCalls: 0, totalTokens: 1740, chargedTokens: 1740, tokensEstimated: false });
    expect((await counters()).userDailyUsed).toBe(1740);
  });

  test('callback failure: the snapshot already received is charged, the failure adds nothing', async () => {
    await play(async function* (ctl) { yield snap(1700); await ctl.runTool({ a: 1 }, true); throw make(C.TOOL_ERROR, { streamStarted: false }); });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ status: 'error', toolFailures: 1, chargedTokens: 1700 });
  });

  test('Groq failure after earlier successful rounds', async () => {
    await play(async function* (ctl) { yield snap(1000); await ctl.runTool(); yield snap(2400); await ctl.runTool(); throw make(C.UNAVAILABLE, { streamStarted: false }); });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ status: 'error', toolCalls: 2, chargedTokens: 2400 });
  });

  test('request timeout / transport loss after a snapshot', async () => {
    await play(async function* () { yield snap(2100); throw make(C.SERVICE_TIMEOUT, { streamStarted: false }); });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ status: 'error', errorCode: C.SERVICE_TIMEOUT, chargedTokens: 2100 });
  });

  test('a provider call that never completed contributes nothing: an error with no snapshot at all charges zero', async () => {
    await play(async function* () { throw make(C.UNAVAILABLE, { streamStarted: false }); });
    await settledAll();
    expect(await lastEvent()).toMatchObject({ status: 'error', chargedTokens: 0 });
  });

  test('duplicate settlement attempts cannot double charge', async () => {
    let reservation;
    const real = limits.settle;
    jest.spyOn(limits, 'settle').mockImplementation(async (a) => { reservation = a.reservation; return real(a); });
    await play(async function* () { yield snap(1000); yield { type: 'text', text: 'a' }; yield done; });
    await settledAll();
    const before = await counters();
    expect(await real({ reservation, actual: 99999 })).toBe(false);
    expect(await counters()).toEqual(before);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  });

  test('plain (non-tool) requests are unchanged: a single usage event passes through to the consumer in place', async () => {
    const r = await play(async function* () { yield { type: 'text', text: 'a' }; yield snap(700); yield done; }, { toolBudget: false });
    expect(r.events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    await settledAll();
    expect(await lastEvent()).toMatchObject({ chargedTokens: 700 });
  });
});

describe('the client: a keepalive counts as proof of life, and ONLY as that', () => {
  const pair = createKeyPair();
  const stub = createStubAiService({ publicKey: pair.publicKey });
  const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_SERVICE_CONNECT_TIMEOUT_MS', 'AI_SERVICE_FIRST_FRAME_TIMEOUT_MS', 'AI_SERVICE_IDLE_TIMEOUT_MS', 'AI_REQUEST_CEILING_MS'];
  const saved = {};
  const IDENT = () => ({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: `req-${Math.random().toString(36).slice(2)}-${Date.now()}` });
  const KA = ': keepalive';
  const chat = async () => {
    const events = []; const t0 = Date.now();
    try { for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100 })) events.push(e); } catch (error) { return { error, events, ms: Date.now() - t0 }; }
    return { events, ms: Date.now() - t0 };
  };
  beforeAll(async () => { await stub.start(); SAVE.forEach((k) => { saved[k] = env[k]; }); Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1' }); });
  afterAll(async () => { Object.assign(env, saved); aiService.resetEngine(); await stub.stop(); });
  beforeEach(() => { stub.reset(); Object.assign(env, { AI_SERVICE_CONNECT_TIMEOUT_MS: 2000, AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 2000, AI_SERVICE_IDLE_TIMEOUT_MS: 2000, AI_REQUEST_CEILING_MS: 10000 }); });
  const text = { type: 'text', text: 'ok' };
  const doneFrame = { ...done };

  test('keepalives satisfy the FIRST-FRAME timeout and reset the IDLE timeout: a long silent round survives', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 400, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ firstFrameDelayMs: 200, gapMs: 200, frames: [KA, KA, KA, KA, KA, text, doneFrame] }); // ~1.2 s with NO data frame, longer than either timer
    const { error, events, ms } = await chat();
    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(ms).toBeGreaterThan(900);
  });

  test('control: the same silence WITHOUT keepalives still times out', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 300, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ firstFrameDelayMs: 900, frames: [text, doneFrame] });
    expect((await chat()).error.code).toBe(C.SERVICE_TIMEOUT);
  });

  test('keepalives can NEVER extend the absolute request deadline', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 5000, AI_SERVICE_IDLE_TIMEOUT_MS: 5000, AI_REQUEST_CEILING_MS: 700 });
    stub.enqueue({ gapMs: 60, frames: Array.from({ length: 80 }, () => KA), hangAfterFrames: true }); // would keep "proving life" for ~5 s
    const { error, ms } = await chat();
    expect(error.code).toBe(C.SERVICE_TIMEOUT);
    expect(ms).toBeLessThan(1500); // ended at ~the 700 ms ceiling
  });

  test('only the EXACT keepalive line resets a timer: any other comment is ignored', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 5000, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ gapMs: 150, frames: [': ping', ': keepalive please', ': KEEPALIVE', ':keepalive', ': ping', ': ping', ': ping'], hangAfterFrames: true });
    const { error, events } = await chat();
    expect(error.code).toBe(C.SERVICE_TIMEOUT);
    expect(events).toEqual([]);
  });

  test('a keepalive followed by a malformed frame still ends the stream at once (nothing is forgiven)', async () => {
    stub.enqueue({ frames: [KA, { type: 'tool_activity', tool: 'nope' }], hangAfterFrames: true });
    const { error, ms } = await chat();
    expect(error.code).toBe(C.SERVICE_PROTOCOL);
    expect(ms).toBeLessThan(1000);
  });

  test('keepalives are not events: nothing reaches the consumer from them, and no usage or output is implied', async () => {
    stub.enqueue({ frames: [KA, KA, text, doneFrame] });
    const { events } = await chat();
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });
});
