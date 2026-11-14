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
 * The REAL pipeline + REAL Node client + a real HTTP server speaking the Python contract.
 * Focus: exactly-once quota settlement across every way the hop can end.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
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
const { completeAiRequest, estimateTokens, streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const oid = () => new mongoose.Types.ObjectId();
const MESSAGES = [{ role: 'user', content: 'PROMPT-SECRET what is our leave policy' }];
const OUTPUT_CAP = 100;
const RESERVED = estimateTokens(MESSAGES) + OUTPUT_CAP;
const redis = () => createRedisClient();
const saved = {};
let org;

const ask = (extra = {}) => completeAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, ...extra });
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};
const ids = () => ({ orgId: users.emp.organization.toString(), userId: users.emp._id.toString() });
const used = async () => (await limits.readCounters({ ...ids(), timeZone: 'Asia/Kolkata' })).userDailyUsed;
const inflight = () => redis().zCard(limits.keys.inflight(ids().orgId, ids().userId));
const reservations = () => redis().keys('test:ai:q:*:r:*');
const events = () => AiUsageEvent.find({}).sort({ createdAt: 1 }).lean();
const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not reached in time');
};
async function clearRedis() {
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
}
const usage = (i, o, estimated = false) => ({ type: 'usage', inputTokens: i, outputTokens: o, totalTokens: i + o, estimated });
const text = (t) => ({ type: 'text', text: t });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await stub.start();
  for (const k of ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_MAX_OUTPUT_TOKENS']) saved[k] = env[k];
  aiService.resetEngine(); // the real client
});
afterAll(async () => {
  Object.assign(env, saved);
  await stub.stop();
  await hub.shutdown();
  await clearRedis();
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  stub.reset();
  aiService.resetEngine();
  env.AI_SERVICE_URL = stub.url;
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

describe('one Node request == one reservation == one settlement', () => {
  test('success: the reported usage is charged once; reservation and slot are released', async () => {
    const result = await ask();
    expect(result.text).toBe('COMPLETION-SECRET answer');
    expect(stub.requests).toHaveLength(1);
    expect(await used()).toBe(30);
    expect(await inflight()).toBe(0);
    expect(await reservations()).toEqual([]);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'success', chargedTokens: 30, quotaSettled: true, provider: 'groq', model: 'openai/gpt-oss-120b', providerRequestId: 'req_stub', reservedTokens: RESERVED });
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  });

  test('the generate token\'s jti IS the usage requestKey (one id end to end)', async () => {
    await ask();
    const [event] = await events();
    expect(stub.requests[0].claims.jti).toBe(event.requestKey);
    expect(stub.requests[0].claims.mo).toBe(OUTPUT_CAP);
  });

  test('Python retrying Groq is invisible: Node sends one request, records one event, charges one usage', async () => {
    // Python's own retries produce exactly the frames of the final attempt: one usage frame.
    stub.enqueue({ frames: [text('ok'), usage(120, 30), stub.DONE] });
    await ask();
    expect(stub.requests).toHaveLength(1);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await used()).toBe(150);
  });

  test('error frame before any output (Python exhausted its retries): refunded in full, never re-sent', async () => {
    stub.enqueue({ frames: [{ type: 'error', code: C.RATE_LIMITED, retryable: true, streamStarted: false, upstreamStatus: 429 }] });
    const error = await rejection(ask());
    expect(error).toMatchObject({ code: C.RATE_LIMITED, streamStarted: false });
    expect(stub.requests).toHaveLength(1);
    expect(await used()).toBe(0);
    expect(await reservations()).toEqual([]);
    expect(await inflight()).toBe(0);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ status: 'error', errorCode: C.RATE_LIMITED, chargedTokens: 0, quotaSettled: true, streamStarted: false });
  });

  test('error after output began: charged an estimate, flagged, settled once', async () => {
    stub.enqueue({ frames: [text('x'.repeat(40)), { type: 'error', code: C.UNAVAILABLE, retryable: false, streamStarted: true, upstreamStatus: null }] });
    const error = await rejection(ask());
    expect(error).toMatchObject({ code: C.UNAVAILABLE, streamStarted: true });
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', streamStarted: true, tokensEstimated: true, quotaSettled: true });
    expect(event.chargedTokens).toBe(estimateTokens(MESSAGES) + 10);
    expect(await used()).toBe(event.chargedTokens);
    expect(await reservations()).toEqual([]);
  });

  test('truncated stream after output (Python died mid-answer): estimate charged, recorded as an error', async () => {
    stub.enqueue({ frames: [text('y'.repeat(80))], truncate: true });
    const error = await rejection(ask());
    expect(error).toMatchObject({ code: C.SERVICE_UNAVAILABLE, streamStarted: true });
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', errorCode: C.SERVICE_UNAVAILABLE, streamStarted: true, tokensEstimated: true, quotaSettled: true });
    expect(event.chargedTokens).toBe(estimateTokens(MESSAGES) + 20);
    expect(await used()).toBe(event.chargedTokens);
    expect(await inflight()).toBe(0);
  });

  test('truncated stream with real usage already reported: the real usage wins', async () => {
    stub.enqueue({ frames: [text('z'), usage(50, 7)], truncate: true });
    await rejection(ask());
    expect((await events())[0]).toMatchObject({ status: 'error', chargedTokens: 57, tokensEstimated: false });
    expect(await used()).toBe(57);
  });

  test('empty/garbage body (nothing delivered): refunded in full', async () => {
    stub.enqueue({ raw: '' });
    await rejection(ask());
    expect(await used()).toBe(0);
    expect((await events())[0]).toMatchObject({ status: 'error', chargedTokens: 0, streamStarted: false });
  });

  test('service down / unauthorised: refunded in full and surfaced as a safe error', async () => {
    stub.enqueue({ status: 401, body: { error: { code: 'TOKEN_INVALID' } } });
    const error = await rejection(ask());
    expect(error).toMatchObject({ code: C.SERVICE_AUTH, statusCode: 502 });
    expect(error.message).not.toMatch(/TOKEN|key|PROMPT/);
    expect(await used()).toBe(0);
    env.AI_SERVICE_URL = 'http://127.0.0.1:1';
    expect((await rejection(ask())).code).toBe(C.SERVICE_UNAVAILABLE);
    expect(await used()).toBe(0);
    expect(await reservations()).toEqual([]);
    expect(await inflight()).toBe(0);
  });

  test('client abort mid-stream: Python is disconnected, estimate charged, ONE settlement, recorded as cancelled', async () => {
    stub.enqueue({ frames: [text('w'.repeat(40))], hangAfterFrames: true });
    const controller = new AbortController();
    const seen = [];
    const run = (async () => {
      try {
        for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, signal: controller.signal })) {
          seen.push(e);
          controller.abort();
        }
      } catch (error) {
        return error;
      }
      return null;
    })();
    const error = await run;
    expect(error.code).toBe(C.ABORTED);
    await until(() => stub.state.disconnects === 1);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'cancelled', errorCode: C.ABORTED, streamStarted: true, tokensEstimated: true, quotaSettled: true });
    expect(await used()).toBe(event.chargedTokens);
    expect(await reservations()).toEqual([]);
    expect(await inflight()).toBe(0);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  });

  test('abort before the first byte: refunded, nothing recorded as a charge', async () => {
    stub.enqueue({ delayMs: 300, frames: [stub.DONE] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const error = await rejection(ask({ signal: controller.signal }));
    expect(error.code).toBe(C.ABORTED);
    expect(await used()).toBe(0);
    expect((await events())[0]).toMatchObject({ status: 'cancelled', chargedTokens: 0 });
  });

  test('a consumer that stops iterating settles exactly once and frees the slot', async () => {
    stub.enqueue({ frames: [text('a'), text('b')], hangAfterFrames: true });
    const it = streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES });
    await it.next();
    await it.return();
    await until(async () => (await AiUsageEvent.countDocuments()) === 1);
    expect(await inflight()).toBe(0);
    expect(await reservations()).toEqual([]);
    expect((await events())[0]).toMatchObject({ status: 'cancelled' });
  });

  test('concurrent requests settle independently and exactly once each', async () => {
    stub.setDefault({ frames: [text('ok'), usage(10, 5), stub.DONE] });
    await Promise.all(Array.from({ length: 8 }, () => ask()));
    expect(stub.requests).toHaveLength(8);
    expect(new Set(stub.requests.map((r) => r.claims.jti)).size).toBe(8); // every token single-use, all distinct
    expect(await used()).toBe(8 * 15);
    expect(await AiUsageEvent.countDocuments()).toBe(8);
    expect(await reservations()).toEqual([]);
  });

  test('the limits still run BEFORE the service: a quota refusal never reaches Python', async () => {
    await AiOrgSettings.updateOne({ organization: org._id }, { quotas: { userDailyTokens: 1000, orgMonthlyTokens: 5000000 } });
    env.AI_MAX_OUTPUT_TOKENS = 5000;
    const error = await rejection(ask());
    expect(error.code).toMatch(/^AI_QUOTA/);
    expect(stub.requests).toHaveLength(0);
  });

  test('an unconfigured service (no Groq key / no signing key) stops everything before limits', async () => {
    stub.setConfigured(false);
    aiService.invalidateStatus();
    expect((await rejection(ask())).code).toBe(C.NOT_CONFIGURED);
    expect(stub.requests.filter((r) => r.body.messages)).toHaveLength(0);
    expect(await redis().keys('test:ai:*')).toEqual([]);
    expect(await AiUsageEvent.countDocuments()).toBe(0);
  });

  test('prompts and completions never reach the usage row', async () => {
    await ask();
    const dump = JSON.stringify(await events());
    for (const secret of ['PROMPT-SECRET', 'COMPLETION-SECRET']) expect(dump).not.toContain(secret);
  });
});
