jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendOtpEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendInvitationEmail: jest.fn().mockResolvedValue({ preview: true }),
}));

const request = require('supertest');
const { createApp } = require('../../src/app');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const emailService = require('../../src/services/email.service');
const Organization = require('../../src/models/Organization');
const platform = require('../../src/services/platform.service');
const planLimits = require('../../src/services/planLimits.service');

const app = createApp();
const PASSWORD = 'Password123';

const otpFor = (email) => emailService.sendOtpEmail.mock.calls.find((args) => args[0].to === email)[0].otp;
const inviteTokenFor = (email) => new URL(emailService.sendInvitationEmail.mock.calls.find((args) => args[0].to === email)[0].inviteUrl).searchParams.get('token');
const csrf = async (agent) => (await agent.get('/api/v1/auth/csrf-token').expect(200)).body.csrfToken;

// The token must be fetched BEFORE the request is built (the agent attaches cookies when the request is created).
async function withCsrf(agent) {
  const token = await csrf(agent);
  return { post: (url) => agent.post(url).set('x-csrf-token', token), patch: (url) => agent.patch(url).set('x-csrf-token', token) };
}

async function signup(email, firstName = 'Ada') {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').send({ firstName, lastName: 'Test', email, password: PASSWORD }).expect(201);
  await agent.post('/api/v1/auth/verify-email').send({ email, otp: otpFor(email) }).expect(200);
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

async function ownerWithOrg(email = 'owner@acme.test') {
  const agent = await signup(email, 'Olive');
  const res = await (await withCsrf(agent)).post('/api/v1/organizations').send({ name: 'Acme Inc' }).expect(201);
  return { agent, organizationId: res.body.organization.id };
}

async function employeeIn(owner, email) {
  await (await withCsrf(owner)).post('/api/v1/invitations').send({ email, role: 'employee' }).expect(201);
  await request(app).post('/api/v1/invitations/accept').send({ token: inviteTokenFor(email), firstName: 'Eve', lastName: 'Emp', password: PASSWORD }).expect(201);
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
});
afterAll(async () => {
  await disconnectTestDb();
  await createRedisClient().quit();
});
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('profile and password', () => {
  it('edits the own profile, ignores nothing silently (unknown fields are rejected)', async () => {
    const { agent } = await ownerWithOrg();
    const res = await (await withCsrf(agent)).patch('/api/v1/auth/me').send({ firstName: 'Olivia', skills: ['Leadership'] }).expect(200);
    expect(res.body.user.firstName).toBe('Olivia');
    expect(res.body.user.skills).toEqual(['Leadership']);
    for (const bad of [{ role: 'guest' }, { email: 'x@y.test' }, { organization: 'abc' }, {}]) {
      await (await withCsrf(agent)).patch('/api/v1/auth/me').send(bad).expect(400);
    }
    expect((await agent.get('/api/v1/auth/me').expect(200)).body.user.role).toBe('org-admin');
  });

  it('changes the password only with the current one, then signs every session out', async () => {
    const { agent } = await ownerWithOrg();
    const wrong = await (await withCsrf(agent)).post('/api/v1/auth/change-password').send({ currentPassword: 'Nope12345', newPassword: 'Another123' }).expect(400);
    expect(wrong.body.code).toBe('INVALID_CURRENT_PASSWORD');
    await (await withCsrf(agent)).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
    await (await withCsrf(agent)).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'weak' }).expect(400);

    await (await withCsrf(agent)).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'Another123' }).expect(200);
    await agent.get('/api/v1/auth/me').expect(401); // old session is gone

    const fresh = request.agent(app);
    await fresh.post('/api/v1/auth/login').send({ email: 'owner@acme.test', password: PASSWORD }).expect(401);
    await fresh.post('/api/v1/auth/login').send({ email: 'owner@acme.test', password: 'Another123' }).expect(200);
  });

  it('requires a login to change a password', async () => {
    const anon = request.agent(app);
    await (await withCsrf(anon)).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'Another123' }).expect(401);
  });
});

describe('organization details', () => {
  it('lets only the organization owner edit them', async () => {
    const { agent, organizationId } = await ownerWithOrg();
    const res = await (await withCsrf(agent)).patch('/api/v1/organizations/me').send({ name: 'Acme Global', timeZone: 'Europe/London' }).expect(200);
    expect(res.body.organization).toMatchObject({ name: 'Acme Global', timeZone: 'Europe/London', plan: 'free' });
    const stored = await Organization.findById(organizationId).lean();
    expect(stored.settings.timezone).toBe('Europe/London');

    await (await withCsrf(agent)).patch('/api/v1/organizations/me').send({ timeZone: 'Mars/Base' }).expect(400);
    for (const forbidden of [{ plan: 'pro' }, { limits: { seats: 999 } }, { slug: 'x-y' }, {}]) {
      await (await withCsrf(agent)).patch('/api/v1/organizations/me').send(forbidden).expect(400);
    }

    const employee = await employeeIn(agent, 'eve@acme.test');
    await (await withCsrf(employee)).patch('/api/v1/organizations/me').send({ name: 'Hacked' }).expect(403);
    await employee.get('/api/v1/organizations/me/usage').expect(403);
    expect((await Organization.findById(organizationId).lean()).name).toBe('Acme Global');
    // someone with no organization has nothing to edit
    const loner = await signup('loner@acme.test');
    await (await withCsrf(loner)).patch('/api/v1/organizations/me').send({ name: 'Nope' }).expect(403);
  });
});

describe('plan limits', () => {
  it('stops invitations at the seat limit (members + pending), and only admins see usage', async () => {
    const { agent, organizationId } = await ownerWithOrg();
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.seats': 2 } });

    await (await withCsrf(agent)).post('/api/v1/invitations').send({ email: 'one@acme.test', role: 'employee' }).expect(201);
    const full = await (await withCsrf(agent)).post('/api/v1/invitations').send({ email: 'two@acme.test', role: 'employee' }).expect(403);
    expect(full.body.code).toBe('SEAT_LIMIT_REACHED');

    const usage = (await agent.get('/api/v1/organizations/me/usage').expect(200)).body.usage;
    expect(usage.seats).toEqual({ used: 1, pendingInvitations: 1, limit: 2 });

    // the reserved seat can still be taken, and then the organization is full for acceptance too
    await request(app).post('/api/v1/invitations/accept').send({ token: inviteTokenFor('one@acme.test'), firstName: 'One', lastName: 'Emp', password: PASSWORD }).expect(201);
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.seats': 3 } });
    await (await withCsrf(agent)).post('/api/v1/invitations').send({ email: 'three@acme.test', role: 'employee' }).expect(201);
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.seats': 2 } });
    const blocked = await request(app).post('/api/v1/invitations/accept').send({ token: inviteTokenFor('three@acme.test'), firstName: 'Three', lastName: 'Emp', password: PASSWORD }).expect(403);
    expect(blocked.body.code).toBe('SEAT_LIMIT_REACHED');
  });

  it('treats a missing or non-positive limit as unlimited and never touches existing members', async () => {
    const { agent, organizationId } = await ownerWithOrg();
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.seats': 0 } });
    await (await withCsrf(agent)).post('/api/v1/invitations').send({ email: 'free@acme.test', role: 'employee' }).expect(201);
  });

  it('stops uploads that would exceed the storage limit but allows deleting-sized headroom', async () => {
    const { agent, organizationId } = await ownerWithOrg();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.storageGB': 10 / 1024 ** 3 } }); // ten bytes
    const res = await (await withCsrf(agent)).post('/api/v1/documents').attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(413);
    expect(res.body.code).toBe('STORAGE_LIMIT_REACHED');

    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.storageGB': 1 } });
    await (await withCsrf(agent)).post('/api/v1/documents').attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201);
    const usage = (await agent.get('/api/v1/organizations/me/usage').expect(200)).body.usage;
    expect(usage.storage.usedBytes).toBe(pdf.length);
    expect(usage.storage.limitGB).toBe(1);
  });

  it('caps AI tokens by credits only when a credit conversion is configured', async () => {
    const env = require('../../src/config/env');
    const { organizationId } = await ownerWithOrg();
    const quotas = { userDailyTokens: 1000, orgMonthlyTokens: 100000 };
    await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.aiCredits': 5 } });
    expect(await planLimits.capAiQuotas(organizationId, quotas)).toEqual(quotas); // no conversion configured: not enforced
    env.AI_TOKENS_PER_CREDIT = 1000;
    try {
      expect((await planLimits.capAiQuotas(organizationId, quotas)).orgMonthlyTokens).toBe(5000);
      await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.aiCredits': 0 } });
      expect(await planLimits.capAiQuotas(organizationId, quotas)).toEqual(quotas); // 0 = not capped by plan
      await Organization.updateOne({ _id: organizationId }, { $set: { 'limits.aiCredits': 500 } });
      expect((await planLimits.capAiQuotas(organizationId, quotas)).orgMonthlyTokens).toBe(100000); // never raises the org's own quota
    } finally {
      env.AI_TOKENS_PER_CREDIT = null;
    }
  });

  it('lets the platform change limits (validated) and records it', async () => {
    const { organizationId } = await ownerWithOrg();
    const actor = { _id: (await require('../../src/models/User').findOne({ email: 'owner@acme.test' }))._id };
    const updated = await platform.updateOrganizationLimits({ organizationId, limits: { seats: 25, storageGB: 5 }, actor, req: null });
    expect(updated.limits).toMatchObject({ seats: 25, storageGB: 5 });
    const { updateLimitsSchema } = require('../../src/validations/platform.validation');
    expect(updateLimitsSchema.safeParse({ seats: 0 }).success).toBe(false);
    expect(updateLimitsSchema.safeParse({ seats: 5, plan: 'pro' }).success).toBe(false);
    expect(updateLimitsSchema.safeParse({}).success).toBe(false);
  });
});
