jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createFakeProvider } = require('../helpers/fakeAiProvider');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_ERROR_CODES: C, AI_LIMIT_CODES: L } = require('../../src/constants/ai.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const limits = require('../../src/services/ai/aiLimits.service');
const { completeAiRequest, computeCharge, estimateTokens, streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { drainUsageOutbox } = require('../../src/services/ai/aiUsageRecorder.service');
const aiService = require('../../src/services/ai/aiService');

const { users, createUser } = createHarness();
const fake = createFakeProvider();
aiService.setEngine(fake);

const oid = () => new mongoose.Types.ObjectId();
const PROMPT = 'PROMPT-SECRET what is our leave policy';
const MESSAGES = [{ role: 'user', content: PROMPT }];
const OUTPUT_CAP = 100;
const RESERVED = estimateTokens(MESSAGES) + OUTPUT_CAP;
const TZ = 'Asia/Kolkata';
const redis = () => createRedisClient();

let orgA; let orgB;
const ask = (actor, extra = {}) => completeAiRequest({ actor, feature: 'chat', messages: MESSAGES, ...extra });
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};
const ids = (actor) => ({ orgId: actor.organization.toString(), userId: actor._id.toString() });
const counters = (actor) => limits.readCounters({ ...ids(actor), timeZone: TZ });
const inflight = (actor) => redis().zCard(limits.keys.inflight(ids(actor).orgId, ids(actor).userId));
const events = () => AiUsageEvent.find({}).sort({ createdAt: 1 }).lean();
const setQuotas = (organization, quotas) => AiOrgSettings.updateOne({ organization }, { quotas });
const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('condition not reached in time');
};
// Rate-limit windows are per wall-clock minute: don't start a rate test in the last seconds of one.
async function alignToMinute() {
  const left = 60000 - (Date.now() % 60000);
  if (left < 6000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}
async function clearRedis() {
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
});

afterAll(async () => {
  await hub.shutdown();
  await clearRedis();
  const client = redis();
  const mail = await client.keys('test:email:*');
  if (mail.length) await client.del(mail);
  await disconnectTestDb();
  await client.quit();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  fake.reset();
  env.AI_GLOBAL_ENABLED = true;
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  env.AI_MAX_OUTPUT_TOKENS = OUTPUT_CAP;
  await clearRedis();
  await Promise.all([AiOrgSettings.deleteMany({}), AiUsageEvent.deleteMany({}), AuditLog.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'emp2', ROLES.EMPLOYEE);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create({ organization: orgA._id, enabled: true }); // orgB: AI never enabled
});

describe('the gate runs before anything else', () => {
  test('a disabled organization never reaches limits, quota or provider', async () => {
    const error = await rejection(ask(users.empB));
    expect(error).toMatchObject({ statusCode: 403, code: C.DISABLED });
    expect(fake.calls).toHaveLength(0);
    expect(await redis().keys('test:ai:*')).toEqual([]);
    expect(await AiUsageEvent.countDocuments()).toBe(0);
  });

  test.each([
    ['guest', 'FORBIDDEN'],
    ['superadmin', 'FORBIDDEN'],
  ])('%s is refused with no side effects', async (key, code) => {
    expect((await rejection(ask(users[key]))).code).toBe(code);
    expect(fake.calls).toHaveLength(0);
    expect(await redis().keys('test:ai:*')).toEqual([]);
  });

  test('a blocked member is refused even with a stale actor object', async () => {
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: true });
    const stale = await User.findById(users.emp._id);
    expect((await rejection(ask(stale))).code).toBe('ORG_BLOCKED');
    expect(fake.calls).toHaveLength(0);
  });

  test('the platform kill switch and an unconfigured AI service stop a previously enabled org', async () => {
    env.AI_GLOBAL_ENABLED = false;
    expect((await rejection(ask(users.emp))).code).toBe(C.DISABLED);
    env.AI_GLOBAL_ENABLED = true;
    fake.setConfigured(false); // AI service unreachable or without a Groq key
    expect((await rejection(ask(users.emp))).code).toBe(C.NOT_CONFIGURED);
    expect(fake.calls).toHaveLength(0);
  });

  test('malformed requests fail validation before any limit is touched', async () => {
    for (const bad of [{ feature: 'nope' }, { messages: [] }, { conversationId: 'not-an-id' }]) {
      const error = await rejection(completeAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, ...bad }));
      expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    expect(await redis().keys('test:ai:*')).toEqual([]);
  });
});

describe('successful request', () => {
  test('streams provider events through and records one accurate, content-free usage event', async () => {
    const conversationId = oid().toString();
    fake.enqueue({ text: ['COMPLETION-', 'SECRET'], usage: { in: 1000, out: 500 } });
    const seen = [];
    for await (const event of streamAiRequest({ actor: users.emp, feature: 'chat', conversationId, messages: MESSAGES })) seen.push(event.type);
    expect(seen).toEqual(['text', 'text', 'usage', 'done']);

    const [event] = await events();
    expect(event).toMatchObject({
      organization: orgA._id,
      user: users.emp._id,
      feature: 'chat',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      status: 'success',
      errorCode: null,
      streamStarted: true,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      tokensEstimated: false,
      reservedTokens: RESERVED,
      chargedTokens: 1500,
      quotaSettled: true,
      estimatedCostMicros: 450, // 1000*0.15 + 500*0.60
      providerRequestId: 'fake_req',
    });
    expect(event.conversation.toString()).toBe(conversationId);
    expect(event.pricingVersion).toMatch(/^[0-9a-f]{8}$/);
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    expect(event.requestKey).toBeTruthy();

    // The quota holds the ACTUAL usage (reservation replaced), the slot is free, the reservation record is gone.
    expect((await counters(users.emp)).userDailyUsed).toBe(1500);
    expect(await inflight(users.emp)).toBe(0);
    expect((await redis().keys(`test:ai:q:*:r:*`))).toEqual([]);
  });

  test('usage events and audit logs never contain prompts, completions or keys', async () => {
    env.AI_SERVICE_SIGNING_KEY = 'gsk_must_never_be_stored';
    await ask(users.emp, { tools: [{ name: 'lookup', parameters: { type: 'object', properties: { secretArg: {} } } }] });
    const allowed = [
      '_id', 'organization', 'user', 'feature', 'conversation', 'requestKey', 'providerRequestId', 'provider', 'model', 'status', 'errorCode',
      'streamStarted', 'inputTokens', 'outputTokens', 'totalTokens', 'tokensEstimated', 'reservedTokens', 'chargedTokens', 'quotaSettled',
      'estimatedCostMicros', 'pricingVersion', 'latencyMs', 'firstEventMs', 'createdAt',
      'toolCalls', 'toolMs', 'toolFailures', // Phase 8: counts and time only (default 0), never what was looked up
    ];
    const stored = await events();
    for (const event of stored) expect(Object.keys(event).filter((key) => !allowed.includes(key))).toEqual([]);
    const dump = JSON.stringify([stored, await AuditLog.find({}).lean()]);
    for (const secret of ['PROMPT-SECRET', 'COMPLETION-SECRET', 'secretArg', 'gsk_must_never_be_stored']) expect(dump).not.toContain(secret);
    expect(await AuditLog.countDocuments({ action: /^ai\./ })).toBe(0); // per-request activity is the usage event, not the audit log
  });

  test('the strict schema drops any stray content field instead of storing it', async () => {
    await AiUsageEvent.updateOne(
      { requestKey: 'k1' },
      { $setOnInsert: { organization: orgA._id, user: users.emp._id, feature: 'chat', requestKey: 'k1', provider: 'groq', model: 'm', status: 'success', prompt: 'PROMPT-SECRET', completion: 'x' } },
      { upsert: true },
    );
    const stored = await AiUsageEvent.findOne({ requestKey: 'k1' }).lean();
    expect(stored.prompt).toBeUndefined();
    expect(stored.completion).toBeUndefined();
  });
});

describe('what each outcome costs against the quota', () => {
  test('provider failure before any output charges nothing and records the error category', async () => {
    fake.enqueue({ failBefore: C.RATE_LIMITED });
    const error = await rejection(ask(users.emp));
    expect(error.code).toBe(C.RATE_LIMITED);
    expect((await counters(users.emp)).userDailyUsed).toBe(0);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', errorCode: C.RATE_LIMITED, chargedTokens: 0, totalTokens: 0, streamStarted: false, reservedTokens: RESERVED });
    expect(await inflight(users.emp)).toBe(0);
  });

  test('failure after output has streamed charges an estimate of what was produced', async () => {
    fake.enqueue({ text: 'x'.repeat(80), failAfter: C.UNAVAILABLE });
    const received = [];
    let error;
    try {
      for await (const event of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES })) received.push(event);
    } catch (err) {
      error = err;
    }
    expect(error.code).toBe(C.UNAVAILABLE);
    expect(received).toHaveLength(1);
    const expected = estimateTokens(MESSAGES) + 20; // 80 chars / 4
    const [event] = await events();
    expect(event).toMatchObject({ status: 'error', errorCode: C.UNAVAILABLE, streamStarted: true, tokensEstimated: true, chargedTokens: expected, outputTokens: 20 });
    expect((await counters(users.emp)).userDailyUsed).toBe(expected);
  });

  test('a successful response with no usage metadata is charged an estimate and flagged', async () => {
    fake.enqueue({ text: 'y'.repeat(40), usage: null });
    await ask(users.emp);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'success', tokensEstimated: true, outputTokens: 10, chargedTokens: estimateTokens(MESSAGES) + 10 });
  });

  test('usage above the reservation is charged in full (quota is soft by at most one under-estimate)', async () => {
    fake.enqueue({ usage: { in: 5000, out: 5000 } });
    await ask(users.emp);
    expect((await counters(users.emp)).userDailyUsed).toBe(10000);
    expect((await events())[0].chargedTokens).toBe(10000);
  });

  test('computeCharge: real provider numbers win; nothing delivered costs nothing', () => {
    const base = { inputEstimate: 30, outputChars: 400 };
    expect(computeCharge({ ...base, status: 'success', started: true, usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } }).tokens).toBe(7);
    expect(computeCharge({ ...base, status: 'cancelled', started: true, usage: { totalTokens: 9, inputTokens: 5, outputTokens: 4 } }).tokens).toBe(9);
    expect(computeCharge({ ...base, status: 'error', started: false, usage: null })).toEqual({ tokens: 0, input: 0, output: 0, estimated: false });
    expect(computeCharge({ ...base, status: 'cancelled', started: true, usage: null })).toMatchObject({ tokens: 130, estimated: true });
  });
});

describe('cancellation', () => {
  test('cancelled before any output: full refund, recorded as cancelled', async () => {
    fake.enqueue({ hang: true }); // no text, then waits for the abort
    const controller = new AbortController();
    const pending = rejection(ask(users.emp, { signal: controller.signal }));
    await until(() => fake.calls.length === 1);
    expect((await counters(users.emp)).userDailyUsed).toBe(RESERVED); // held while running
    controller.abort();
    expect((await pending).code).toBe(C.ABORTED);
    expect((await counters(users.emp)).userDailyUsed).toBe(0);
    expect((await events())[0]).toMatchObject({ status: 'cancelled', errorCode: C.ABORTED, chargedTokens: 0, streamStarted: false });
    expect(await inflight(users.emp)).toBe(0);
  });

  test('consumer stops after output began: charged for what was produced, recorded as cancelled', async () => {
    fake.enqueue({ text: ['z'.repeat(40), 'more'], usage: { in: 10, out: 10 } });
    for await (const event of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES })) {
      if (event.type === 'text') break; // client went away
    }
    const [event] = await events();
    expect(event).toMatchObject({ status: 'cancelled', streamStarted: true, tokensEstimated: true });
    expect(event.chargedTokens).toBe(estimateTokens(MESSAGES) + 10);
    expect((await counters(users.emp)).userDailyUsed).toBe(event.chargedTokens);
    expect(await inflight(users.emp)).toBe(0);
  });

  test('an already-aborted signal costs nothing and leaves nothing held', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await rejection(ask(users.emp, { signal: controller.signal }))).code).toBe(C.ABORTED);
    expect((await counters(users.emp)).userDailyUsed).toBe(0);
    expect(await inflight(users.emp)).toBe(0);
  });
});

describe('rate limiting and concurrency (before the provider is called)', () => {
  test('requests over the per-minute limit are refused with a retry hint; nothing is charged for them', async () => {
    await alignToMinute();
    env.AI_RATE_LIMIT_PER_MINUTE = 3;
    for (let i = 0; i < 3; i += 1) await ask(users.emp);
    const used = (await counters(users.emp)).userDailyUsed;

    const error = await rejection(ask(users.emp));
    expect(error).toMatchObject({ statusCode: 429, code: L.RATE_LIMITED });
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(fake.calls).toHaveLength(3);
    expect((await counters(users.emp)).userDailyUsed).toBe(used);
    expect(await AiUsageEvent.countDocuments()).toBe(3); // refused-by-rate-limit is not a usage event
    await ask(users.emp2); // another member is unaffected
  });

  test('the window resets on the next minute (deterministic clock)', async () => {
    env.AI_RATE_LIMIT_PER_MINUTE = 1;
    const ctx = { ...ids(users.emp), requestKey: 'a' };
    const t0 = Math.floor(Date.now() / 60000) * 60000 + 1000;
    await limits.admit({ ...ctx, now: t0 });
    await limits.release(ctx);
    expect((await rejection(limits.admit({ ...ctx, requestKey: 'b', now: t0 + 5000 }))).code).toBe(L.RATE_LIMITED);
    await limits.admit({ ...ctx, requestKey: 'c', now: t0 + 60000 });
  });

  test('too many simultaneous requests are refused until one finishes', async () => {
    env.AI_MAX_CONCURRENT_PER_USER = 2;
    fake.setDefault({ hang: true });
    const a = new AbortController(); const b = new AbortController();
    const first = rejection(ask(users.emp, { signal: a.signal }));
    const second = rejection(ask(users.emp, { signal: b.signal }));
    await until(() => fake.calls.length === 2);

    expect(await rejection(ask(users.emp))).toMatchObject({ statusCode: 429, code: L.TOO_MANY_CONCURRENT });
    expect(fake.calls).toHaveLength(2);
    fake.setDefault({ text: 'ok', usage: { in: 1, out: 1 } });
    await ask(users.emp2); // different member: own slots

    a.abort();
    await first;
    await until(async () => (await inflight(users.emp)) === 1);
    await ask(users.emp); // a slot is free again
    b.abort();
    await second;
    expect(await inflight(users.emp)).toBe(0);
  });
});

describe('quotas', () => {
  test('a user who has used their daily budget is refused, recorded as denied, and the provider is never called', async () => {
    await setQuotas(orgA._id, { userDailyTokens: 1000, orgMonthlyTokens: 1000000 });
    fake.setDefault({ text: 'ok', usage: { in: 200, out: 100 } });
    for (let i = 0; i < 3; i += 1) await ask(users.emp); // 900 used
    expect((await counters(users.emp)).userDailyUsed).toBe(900);

    const error = await rejection(ask(users.emp));
    expect(error).toMatchObject({ statusCode: 429, code: L.QUOTA_USER_DAILY });
    expect(new Date(error.details.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(fake.calls).toHaveLength(3);
    const denied = (await events()).filter((event) => event.status === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ errorCode: L.QUOTA_USER_DAILY, totalTokens: 0, chargedTokens: 0, reservedTokens: RESERVED });
    expect(await inflight(users.emp)).toBe(0);

    fake.setDefault({ text: 'ok', usage: { in: 1, out: 1 } });
    await ask(users.emp2); // another member's daily budget is untouched
  });

  test('the organization monthly budget is shared, and a refusal reserves nothing for the user either', async () => {
    await setQuotas(orgA._id, { userDailyTokens: 1000000, orgMonthlyTokens: 1000 });
    fake.setDefault({ text: 'ok', usage: { in: 200, out: 100 } });
    for (let i = 0; i < 3; i += 1) await ask(users.emp);

    const error = await rejection(ask(users.emp2));
    expect(error).toMatchObject({ statusCode: 429, code: L.QUOTA_ORG_MONTHLY });
    const after = await counters(users.emp2);
    expect(after.userDailyUsed).toBe(0); // atomic: the user counter was not incremented by the refused request
    expect(after.orgMonthlyUsed).toBe(900);
  });

  test('a single request larger than the whole quota is refused outright', async () => {
    await setQuotas(orgA._id, { userDailyTokens: 100, orgMonthlyTokens: 100 });
    const error = await rejection(ask(users.emp));
    expect(error).toMatchObject({ statusCode: 413, code: L.REQUEST_TOO_LARGE });
    expect(fake.calls).toHaveLength(0);
  });

  test('quota changes apply to the very next request', async () => {
    fake.setDefault({ text: 'ok', usage: { in: 200, out: 100 } });
    await ask(users.emp);
    await setQuotas(orgA._id, { userDailyTokens: 310, orgMonthlyTokens: 1000000 }); // 300 used, 130 needed
    expect((await rejection(ask(users.emp))).code).toBe(L.QUOTA_USER_DAILY);
    await setQuotas(orgA._id, { userDailyTokens: 5000, orgMonthlyTokens: 1000000 });
    await ask(users.emp);
  });

  test('budgets are per organization: another org with the same activity is independent', async () => {
    await AiOrgSettings.create({ organization: orgB._id, enabled: true, quotas: { userDailyTokens: 1000, orgMonthlyTokens: 1000 } });
    fake.setDefault({ text: 'ok', usage: { in: 200, out: 100 } });
    await setQuotas(orgA._id, { userDailyTokens: 1000, orgMonthlyTokens: 1000 });
    for (let i = 0; i < 3; i += 1) await ask(users.emp);
    expect((await rejection(ask(users.emp2))).code).toBe(L.QUOTA_ORG_MONTHLY); // org A is spent
    await ask(users.empB); // org B is not
    expect((await counters(users.empB)).orgMonthlyUsed).toBe(300);
  });
});

describe('concurrency safety (no check-then-increment race)', () => {
  test('50 simultaneous reservations against a 1000-token budget admit exactly 10', async () => {
    const quotas = { userDailyTokens: 1000, orgMonthlyTokens: 100000 };
    const context = ids(users.emp);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => limits.reserve({ ...context, requestKey: `r${i}`, amount: 100, quotas, timeZone: TZ })),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === 'rejected' && o.reason.code === L.QUOTA_USER_DAILY)).toHaveLength(40);
    const used = await counters(users.emp);
    expect(used.userDailyUsed).toBe(1000);
    expect(used.orgMonthlyUsed).toBe(1000);
  });

  test('30 simultaneous full requests: only what fits is sent to the provider, the rest are refused', async () => {
    await setQuotas(orgA._id, { userDailyTokens: 1000, orgMonthlyTokens: 1000000 });
    const fits = Math.floor(1000 / RESERVED);
    fake.closeGate();
    fake.setDefault({ gate: true, text: 'ok', usage: { in: 50, out: 50 } });

    let refused = 0;
    const all = Array.from({ length: 30 }, () =>
      ask(users.emp).catch((error) => {
        if (error.code === L.QUOTA_USER_DAILY) refused += 1;
        else throw error;
        return null;
      }),
    );
    await until(() => refused === 30 - fits && fake.calls.length === fits);
    expect(fake.calls).toHaveLength(fits);
    expect((await counters(users.emp)).userDailyUsed).toBe(fits * RESERVED); // in-flight work already counts

    fake.openGate();
    const results = await Promise.all(all);
    expect(results.filter(Boolean)).toHaveLength(fits);
    expect((await counters(users.emp)).userDailyUsed).toBe(fits * 100); // reservations replaced by actual usage
    expect(await inflight(users.emp)).toBe(0);
    const stored = await events();
    expect(stored.filter((e) => e.status === 'success')).toHaveLength(fits);
    expect(stored.filter((e) => e.status === 'denied')).toHaveLength(30 - fits);
  });

  test('settlement is idempotent: a duplicate settle cannot double-charge or double-refund', async () => {
    const quotas = { userDailyTokens: 10000, orgMonthlyTokens: 100000 };
    const reservation = await limits.reserve({ ...ids(users.emp), requestKey: 'dup', amount: 500, quotas, timeZone: TZ });
    expect(await limits.settle({ reservation, actual: 120 })).toBe(true);
    expect(await limits.settle({ reservation, actual: 9999 })).toBe(false);
    expect(await limits.settle({ reservation, actual: 0 })).toBe(false);
    expect((await counters(users.emp)).userDailyUsed).toBe(120);
  });

  test('reserving the same request twice holds the amount once', async () => {
    const quotas = { userDailyTokens: 10000, orgMonthlyTokens: 100000 };
    const context = { ...ids(users.emp), requestKey: 'same', amount: 500, quotas, timeZone: TZ };
    await limits.reserve(context);
    await limits.reserve(context);
    expect((await counters(users.emp)).userDailyUsed).toBe(500);
  });
});

describe('Redis failure fails closed', () => {
  test('Redis not connected: AI is refused with a 503 and the provider is never called', async () => {
    jest.spyOn(redis(), 'isOpen', 'get').mockReturnValue(false);
    const error = await rejection(ask(users.emp));
    expect(error).toMatchObject({ statusCode: 503, code: L.LIMITS_UNAVAILABLE });
    expect(fake.calls).toHaveLength(0);
  });

  test('Redis commands failing: refused, not unmetered', async () => {
    jest.spyOn(redis(), 'eval').mockRejectedValue(new Error('connection reset'));
    const error = await rejection(ask(users.emp));
    expect(error).toMatchObject({ statusCode: 503, code: L.LIMITS_UNAVAILABLE });
    expect(error.message).not.toMatch(/connection reset/);
    expect(fake.calls).toHaveLength(0);
  });

  test('Redis failing only at settlement: the user still gets their answer, the reservation stays counted, the event says so', async () => {
    const client = redis();
    const original = client.eval.bind(client);
    let calls = 0;
    jest.spyOn(client, 'eval').mockImplementation((...args) => (++calls <= 2 ? original(...args) : Promise.reject(new Error('redis down'))));
    const result = await ask(users.emp);
    expect(result.text).toContain('COMPLETION-SECRET');
    jest.restoreAllMocks();

    const [event] = await events();
    expect(event).toMatchObject({ status: 'success', quotaSettled: false, chargedTokens: 30 });
    expect((await counters(users.emp)).userDailyUsed).toBe(RESERVED); // over-counted (conservative), never under-counted
  });

  test('usage counters are unreadable => reported as unavailable, not as zero', async () => {
    jest.spyOn(redis(), 'mGet').mockRejectedValue(new Error('down'));
    expect(await counters(users.emp)).toBeNull();
  });
});

describe('usage persistence failures never fail the request', () => {
  test('a transient MongoDB error is retried and the event is stored once', async () => {
    jest.spyOn(AiUsageEvent, 'updateOne').mockRejectedValueOnce(new Error('mongo blip'));
    const result = await ask(users.emp);
    expect(result.text).toBeTruthy();
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await redis().lLen(limits.keys.outbox())).toBe(0);
  });

  test('a lasting MongoDB outage parks the event in Redis and a later drain stores it exactly once', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(AiUsageEvent, 'updateOne').mockRejectedValue(new Error('mongo down'));
    const result = await ask(users.emp, { feature: 'summarize' });
    expect(result.text).toBeTruthy(); // the answer was already generated; it is delivered
    expect(await AiUsageEvent.countDocuments()).toBe(0);
    expect(await redis().lLen(limits.keys.outbox())).toBe(1);

    expect(await drainUsageOutbox()).toBe(0); // still down: the event is put back, not lost
    expect(await redis().lLen(limits.keys.outbox())).toBe(1);

    spy.mockRestore();
    expect(await drainUsageOutbox()).toBe(1);
    expect(await drainUsageOutbox()).toBe(0);
    expect(await redis().lLen(limits.keys.outbox())).toBe(0);
    const [event] = await events();
    expect(event).toMatchObject({ feature: 'summarize', status: 'success', chargedTokens: 30 });
    expect(event.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(event)).not.toContain('PROMPT-SECRET');
  });

  test('a duplicate delivery of the same event is harmless (idempotent by request key)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(AiUsageEvent, 'updateOne').mockRejectedValue(new Error('down'));
    await ask(users.emp);
    const [raw] = await redis().lRange(limits.keys.outbox(), 0, -1);
    spy.mockRestore();
    await redis().lPush(limits.keys.outbox(), raw); // delivered twice
    await drainUsageOutbox();
    expect(await AiUsageEvent.countDocuments()).toBe(1);
  });

  test('if MongoDB and Redis are both unavailable the request still succeeds and the loss is logged without content', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(AiUsageEvent, 'updateOne').mockRejectedValue(new Error('mongo down'));
    jest.spyOn(redis(), 'lPush').mockRejectedValue(new Error('redis down'));
    const result = await ask(users.emp);
    expect(result.text).toBeTruthy();
    const lost = log.mock.calls.find((call) => String(call[0]).includes('LOST usage event'));
    expect(lost).toBeTruthy();
    expect(lost[1]).toMatchObject({ feature: 'chat', status: 'success', totalTokens: 30 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PROMPT-SECRET|COMPLETION-SECRET/);
  });
});
