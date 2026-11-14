jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/** Usage reporting endpoints: who sees what, org isolation, accurate totals, no content. */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createFakeProvider } = require('../helpers/fakeAiProvider');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const { localDateOf } = require('../../src/utils/timezone');

const { users, createUser, makeAgent, as } = createHarness();
aiService.setEngine(createFakeProvider());
const KEYS = ['superadmin', 'admin', 'hr', 'manager', 'emp', 'emp2', 'guest', 'adminB', 'empB'];
const api = (p = '') => `/api/v1/ai${p}`;
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
let orgA; let orgB;

function event(org, user, over = {}) {
  return {
    organization: org._id,
    user: user._id,
    feature: 'chat',
    requestKey: crypto.randomUUID(),
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    status: 'success',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    tokensEstimated: false,
    reservedTokens: 200,
    chargedTokens: 150,
    quotaSettled: true,
    estimatedCostMicros: 45,
    pricingVersion: 'abcd1234',
    latencyMs: 400,
    createdAt: new Date(),
    ...over,
  };
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all(KEYS.map(makeAgent));
});
afterAll(async () => {
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  await Promise.all([AiUsageEvent.deleteMany({}), AiOrgSettings.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'emp2', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
  await AiUsageEvent.create([
    event(orgA, users.emp),
    event(orgA, users.emp, { status: 'error', errorCode: 'AI_PROVIDER_UNAVAILABLE', inputTokens: 40, outputTokens: 0, totalTokens: 40, tokensEstimated: true, estimatedCostMicros: 6, feature: 'summarize' }),
    event(orgA, users.emp, { status: 'denied', errorCode: 'AI_QUOTA_USER_DAILY', inputTokens: 0, outputTokens: 0, totalTokens: 0, chargedTokens: 0, estimatedCostMicros: null }),
    event(orgA, users.emp2, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedCostMicros: 450, model: 'some/unpriced', provider: 'groq' }),
    event(orgA, users.emp2, { status: 'cancelled', errorCode: 'AI_REQUEST_ABORTED', inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    event(orgB, users.empB, { inputTokens: 7777, outputTokens: 1, totalTokens: 7778 }),
    event(orgA, users.emp, { createdAt: new Date(Date.now() - 400 * 86400000), totalTokens: 99999 }),
  ]);
});

describe('GET /ai/usage/me', () => {
  test('a member sees only their own usage, with accurate totals and a status breakdown', async () => {
    const { usage } = (await as('emp').get(api('/usage/me')).expect(200)).body;
    expect(usage.totals).toMatchObject({ requests: 3, successes: 1, errors: 1, denied: 1, cancelled: 0, inputTokens: 140, outputTokens: 50, totalTokens: 190, estimatedTokenRequests: 1 });
    expect(usage.totals.estimatedCostUsd).toBe(0.000051);
    expect(usage.byFeature.map((f) => f.feature).sort()).toEqual(['chat', 'summarize']);
    expect(usage.quota).toMatchObject({ available: true, dailyLimit: 100000, dailyUsed: 0 });
    expect(usage.pricingVersion).toBeTruthy();
    expect(JSON.stringify(usage)).not.toContain('7778'); // never another org's numbers
  });

  test('colleagues are invisible: emp2 sees their own, not emp\'s', async () => {
    const { usage } = (await as('emp2').get(api('/usage/me')).expect(200)).body;
    expect(usage.totals).toMatchObject({ requests: 2, totalTokens: 1515, unpricedRequests: 0 });
  });

  test('guests and super-admin have no AI usage page', async () => {
    await as('guest').get(api('/usage/me')).expect(403);
    await as('superadmin').get(api('/usage/me')).expect(403);
  });

  test('the date range limits the data and is validated', async () => {
    const day = localDateOf(new Date(), 'Asia/Kolkata'); // the org's default zone; a UTC date can be a different day
    const { usage } = (await as('emp').get(api(`/usage/me?from=${day}&to=${day}`)).expect(200)).body;
    expect(usage.totals.requests).toBe(3);
    await as('emp').get(api('/usage/me?from=not-a-date')).expect(400);
    await as('emp').get(api('/usage/me?bogus=1')).expect(400);
  });

  test('old events outside the default window are not counted', async () => {
    const { usage } = (await as('emp').get(api('/usage/me')).expect(200)).body;
    expect(JSON.stringify(usage)).not.toContain('99999');
  });
});

describe('GET /ai/usage (organization)', () => {
  test('org admins see organization totals, per-person rows by name, models and error codes', async () => {
    const { usage } = (await as('admin').get(api('/usage')).expect(200)).body;
    expect(usage.totals).toMatchObject({ requests: 5, totalTokens: 1705 });
    expect(usage.byUser.map((u) => u.name).sort()).toEqual(['Emp Tester', 'Emp2 Tester']);
    expect(usage.byModel.map((m) => m.model).sort()).toEqual(['openai/gpt-oss-120b', 'some/unpriced']);
    expect(usage.byModel.find((m) => m.model === 'some/unpriced').unpricedRequests).toBe(0); // it has an estimate stored, so it is "priced"
    expect(usage.errors.map((e) => e.code).sort()).toEqual(['AI_PROVIDER_UNAVAILABLE', 'AI_QUOTA_USER_DAILY', 'AI_REQUEST_ABORTED']);
    expect(usage.quota).toMatchObject({ available: true, monthlyLimit: 5000000 });
  });

  test('another organization\'s admin sees only their own organization', async () => {
    const { usage } = (await as('adminB').get(api('/usage')).expect(200)).body;
    expect(usage.totals.requests).toBe(1);
    expect(usage.totals.totalTokens).toBe(7778);
    expect(JSON.stringify(usage)).not.toMatch(/Emp Tester|Emp2 Tester|1705/);
  });

  test.each(['hr', 'manager', 'emp', 'guest', 'superadmin'])('%s cannot see organization usage', async (key) => {
    await as(key).get(api('/usage')).expect(403);
  });

  test('a removed member\'s usage is kept under a neutral label', async () => {
    await User.deleteOne({ _id: users.emp2._id });
    const { usage } = (await as('admin').get(api('/usage')).expect(200)).body;
    expect(usage.byUser.map((u) => u.name).sort()).toEqual(['Emp Tester', 'Former member']);
  });

  test('the response never carries prompt/completion fields or raw request keys', async () => {
    const body = JSON.stringify((await as('admin').get(api('/usage')).expect(200)).body);
    for (const word of ['prompt', 'completion', 'requestKey', 'messages', 'providerRequestId']) expect(body).not.toContain(word);
  });
});

describe('GET /ai/platform/usage (super-admin)', () => {
  test('platform totals only: no organization names or ids, no users, no rows', async () => {
    const { usage } = (await as('superadmin').get(api('/platform/usage')).expect(200)).body;
    expect(usage.activeOrganizations).toBe(2);
    expect(usage.totals).toMatchObject({ requests: 6, totalTokens: 1705 + 7778 });
    const body = JSON.stringify(usage);
    for (const needle of ['Acme', 'Globex', orgA._id.toString(), orgB._id.toString(), 'Tester', users.emp._id.toString()]) expect(body).not.toContain(needle);
    expect(usage).not.toHaveProperty('byUser');
  });

  test.each(['admin', 'hr', 'emp', 'guest', 'adminB'])('%s cannot see platform usage', async (key) => {
    await as(key).get(api('/platform/usage')).expect(403);
  });
});

test('usage endpoints need authentication', async () => {
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const app = createApp();
  for (const p of ['/usage/me', '/usage', '/platform/usage', '/status', '/settings']) {
    expect((await request(app).get(api(p))).status).toBe(401);
  }
});
