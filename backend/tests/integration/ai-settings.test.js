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
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_DISCLOSURE, AI_QUOTA_DEFAULTS } = require('../../src/constants/ai.constants');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const { createFakeProvider } = require('../helpers/fakeAiProvider');
const { assertAiAvailable } = require('../../src/services/ai/aiSettings.service');

const { users, createUser, makeAgent, as } = createHarness();
const KEYS = ['superadmin', 'admin', 'admin2', 'hr', 'manager', 'emp', 'guest', 'adminB', 'empB'];
const SECRET = 'gsk_integration_test_key_do_not_leak';
const fake = createFakeProvider(); // stands in for the Python AI service: "configured" == it reports a Groq key
aiService.setEngine(fake);
const api = (path = '') => `/api/v1/ai${path}`;
const oid = () => new mongoose.Types.ObjectId();
const enable = (key = 'admin', version = AI_DISCLOSURE.version) => as(key).put(api('/settings')).send({ enabled: true, acceptDisclosureVersion: version });

let orgA; let orgB;

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all(KEYS.map(makeAgent));
});

afterAll(async () => {
  await hub.shutdown();
  const client = createRedisClient();
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);
  await disconnectTestDb();
  await client.quit();
});

beforeEach(async () => {
  fake.setConfigured(true); // no request is ever made to the AI service in this file
  env.AI_SERVICE_SIGNING_KEY = SECRET; // must never surface in any response, audit entry or log
  env.AI_GLOBAL_ENABLED = true;
  await Promise.all([AiOrgSettings.deleteMany({}), AuditLog.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'admin2', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
});

describe('default state: AI is off', () => {
  test('a fresh organization has AI disabled and nobody is "ready"', async () => {
    for (const key of ['admin', 'admin2', 'hr', 'manager', 'emp']) {
      const body = (await as(key).get(api('/status')).expect(200)).body.status;
      expect(body).toMatchObject({ ready: false, reason: 'ORG_DISABLED', organizationEnabled: false });
    }
    const settings = (await as('admin').get(api('/settings')).expect(200)).body.settings;
    expect(settings.enabled).toBe(false);
    expect(settings.quotas).toEqual(AI_QUOTA_DEFAULTS);
    expect(await AiOrgSettings.countDocuments()).toBe(0); // reading never creates a row
  });

  test('assertAiAvailable refuses everyone while disabled', async () => {
    await expect(assertAiAvailable({ actor: users.emp })).rejects.toMatchObject({ statusCode: 403, code: 'AI_DISABLED' });
    await expect(assertAiAvailable({ actor: users.admin })).rejects.toMatchObject({ statusCode: 403, code: 'AI_DISABLED' });
  });
});

describe('who may do what', () => {
  test('guests and super-admin have no AI access to tenant routes (backend enforced)', async () => {
    for (const key of ['guest', 'superadmin']) {
      expect((await as(key).get(api('/status'))).status).toBe(403);
      expect((await as(key).get(api('/settings'))).status).toBe(403);
      expect((await as(key).put(api('/settings')).send({ enabled: true, acceptDisclosureVersion: AI_DISCLOSURE.version })).status).toBe(403);
    }
    await expect(assertAiAvailable({ actor: users.guest })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  test('guests stay blocked even after an admin enables AI', async () => {
    await enable().expect(200);
    expect((await as('guest').get(api('/status'))).status).toBe(403);
    await expect(assertAiAvailable({ actor: users.guest })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('only org-admin / admin can read or change settings (hr, manager, employee cannot)', async () => {
    for (const key of ['hr', 'manager', 'emp']) {
      expect((await as(key).get(api('/settings'))).status).toBe(403);
      expect((await as(key).get(api('/disclosure'))).status).toBe(403);
      expect((await enable(key)).status).toBe(403);
    }
    expect(await AiOrgSettings.countDocuments()).toBe(0);
    await as('admin2').get(api('/settings')).expect(200); // admin == org-admin
  });

  test('unauthenticated requests are rejected', async () => {
    const request = require('supertest');
    const { app } = createHarness();
    expect((await request(app).get(api('/status'))).status).toBe(401);
  });

  test('a blocked member loses AI along with org access', async () => {
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: true });
    expect((await as('emp').get(api('/status')).expect(403)).body.code).toBe('ORG_BLOCKED');
  });
});

describe('enabling requires the disclosure', () => {
  test('is refused without or with the wrong disclosure version', async () => {
    const missing = await as('admin').put(api('/settings')).send({ enabled: true }).expect(400);
    expect(missing.body.code).toBe('DISCLOSURE_REQUIRED');
    const stale = await enable('admin', 'v0-old').expect(400);
    expect(stale.body.code).toBe('DISCLOSURE_REQUIRED');
    expect(await AiOrgSettings.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_ENABLED })).toBe(0);
  });

  test('the disclosure endpoint names the provider and the data that may be sent', async () => {
    const { disclosure } = (await as('admin').get(api('/disclosure')).expect(200)).body;
    expect(disclosure.version).toBe(AI_DISCLOSURE.version);
    expect(disclosure.provider).toBe('Groq');
    expect(disclosure.points.join(' ')).toMatch(/external AI provider/i);
    expect(disclosure.points.join(' ')).toMatch(/private documents/i);
  });

  test('enabling records who accepted what, audits it, and flips everyone to ready', async () => {
    const res = await enable().expect(200);
    expect(res.body.settings).toMatchObject({ enabled: true, disclosure: { acceptedVersion: AI_DISCLOSURE.version, needsReacceptance: false } });

    const row = await AiOrgSettings.findOne({ organization: orgA._id }).lean();
    expect(row.disclosure.acceptedBy.toString()).toBe(users.admin._id.toString());
    expect(row.disclosure.provider).toBe('groq');
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_ENABLED }).lean();
    expect(audit.user.toString()).toBe(users.admin._id.toString());
    expect(audit.organization.toString()).toBe(orgA._id.toString());

    for (const key of ['admin', 'hr', 'manager', 'emp']) {
      expect((await as(key).get(api('/status')).expect(200)).body.status).toMatchObject({ ready: true, reason: null });
    }
    await expect(assertAiAvailable({ actor: users.emp })).resolves.toMatchObject({ quotas: AI_QUOTA_DEFAULTS });
  });

  test('cannot be enabled when the AI service is unreachable or has no provider key, or the platform kill switch is on', async () => {
    fake.setConfigured(false);
    const unconfigured = await enable().expect(503);
    expect(unconfigured.body.code).toBe('AI_NOT_CONFIGURED');
    fake.setConfigured(true);
    env.AI_GLOBAL_ENABLED = false;
    expect((await enable().expect(409)).body.code).toBe('AI_DISABLED');
    expect(await AiOrgSettings.countDocuments()).toBe(0);
  });

  test('turning AI off takes effect on the very next request, and is audited', async () => {
    await enable().expect(200);
    await as('emp').get(api('/status')).expect(200);
    await as('admin2').put(api('/settings')).send({ enabled: false }).expect(200);
    expect((await as('emp').get(api('/status')).expect(200)).body.status).toMatchObject({ ready: false, reason: 'ORG_DISABLED' });
    await expect(assertAiAvailable({ actor: users.emp })).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_DISABLED })).toBe(1);
  });

  test('the platform kill switch and a missing key stop already-enabled organizations at once', async () => {
    await enable().expect(200);
    env.AI_GLOBAL_ENABLED = false;
    expect((await as('emp').get(api('/status')).expect(200)).body.status.reason).toBe('PLATFORM_DISABLED');
    await expect(assertAiAvailable({ actor: users.emp })).rejects.toMatchObject({ code: 'AI_DISABLED' });
    env.AI_GLOBAL_ENABLED = true;
    fake.setConfigured(false);
    expect((await as('emp').get(api('/status')).expect(200)).body.status.reason).toBe('NOT_CONFIGURED');
    await expect(assertAiAvailable({ actor: users.emp })).rejects.toMatchObject({ statusCode: 503, code: 'AI_NOT_CONFIGURED' });
  });

  test('a no-op disable does not create a row or an audit entry', async () => {
    await as('admin').put(api('/settings')).send({ enabled: false }).expect(200);
    expect(await AiOrgSettings.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_DISABLED })).toBe(0);
  });

  test('re-enabling after a disclosure change needs the new version, and a stale acceptance is flagged', async () => {
    await enable().expect(200);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { 'disclosure.version': 'v0-old' });
    const settings = (await as('admin').get(api('/settings')).expect(200)).body.settings;
    expect(settings.disclosure).toMatchObject({ acceptedVersion: 'v0-old', needsReacceptance: true });
  });
});

describe('organization isolation', () => {
  test('enabling one organization never enables another', async () => {
    await enable('admin').expect(200);
    expect((await as('empB').get(api('/status')).expect(200)).body.status).toMatchObject({ ready: false, reason: 'ORG_DISABLED' });
    await expect(assertAiAvailable({ actor: users.empB })).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect((await as('adminB').get(api('/settings')).expect(200)).body.settings.enabled).toBe(false);
  });

  test('another organization admin disabling theirs does not touch ours', async () => {
    await enable('admin').expect(200);
    await enable('adminB').expect(200);
    await as('adminB').put(api('/settings')).send({ enabled: false }).expect(200);
    expect((await as('emp').get(api('/status')).expect(200)).body.status.ready).toBe(true);
  });
});

describe('quotas', () => {
  test('are validated, audited, and can be reset to the platform default', async () => {
    const res = await as('admin').put(api('/settings')).send({ quotas: { userDailyTokens: 5000, orgMonthlyTokens: 250000 } }).expect(200);
    expect(res.body.settings.quotas).toEqual({ userDailyTokens: 5000, orgMonthlyTokens: 250000 });
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_SETTINGS_UPDATED }).lean();
    expect(audit.metadata.fields.sort()).toEqual(['orgMonthlyTokens', 'userDailyTokens']);
    expect(audit.metadata.from).toEqual(AI_QUOTA_DEFAULTS);
    expect(audit.metadata.to).toEqual({ userDailyTokens: 5000, orgMonthlyTokens: 250000 });

    const reset = await as('admin').put(api('/settings')).send({ quotas: { userDailyTokens: null } }).expect(200);
    expect(reset.body.settings.quotas).toEqual({ userDailyTokens: AI_QUOTA_DEFAULTS.userDailyTokens, orgMonthlyTokens: 250000 });
  });

  test('reject out-of-range values, unknown fields and empty updates', async () => {
    for (const body of [
      { quotas: { userDailyTokens: 10 } },
      { quotas: { userDailyTokens: 2e12 } },
      { quotas: { userDailyTokens: 1.5e4 + 0.5 } },
      { quotas: { bogus: 1 } },
      { enabled: 'yes' },
      { somethingElse: true },
      {},
    ]) {
      expect((await as('admin').put(api('/settings')).send(body)).status).toBe(400);
    }
  });

  test('assertAiAvailable reports the effective quotas', async () => {
    await enable().expect(200);
    await as('admin').put(api('/settings')).send({ quotas: { userDailyTokens: 7000 } }).expect(200);
    await expect(assertAiAvailable({ actor: users.hr })).resolves.toEqual({
      quotas: { userDailyTokens: 7000, orgMonthlyTokens: AI_QUOTA_DEFAULTS.orgMonthlyTokens },
      liveDataEnabled: false, // Phase 8: separate switch, off by default
    });
  });
});

describe('platform administration (super-admin)', () => {
  test('sees provider health and an aggregate count only, no tenant content and no key', async () => {
    await enable('admin').expect(200);
    await enable('adminB').expect(200);
    const res = await as('superadmin').get(api('/platform/status')).expect(200);
    expect(res.body.platform).toMatchObject({ provider: 'groq', configured: true, globalEnabled: true, organizationsEnabled: 2 });
    expect(res.body.platform.models.chat).toBe('openai/gpt-oss-120b');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('Acme');
    expect(serialized).not.toContain(orgA._id.toString());
  });

  test('is closed to every tenant role', async () => {
    for (const key of ['admin', 'admin2', 'hr', 'manager', 'emp', 'guest']) {
      expect((await as(key).get(api('/platform/status'))).status).toBe(403);
    }
  });
});

describe('secret hygiene', () => {
  test('the provider key never appears in any AI response', async () => {
    await enable().expect(200);
    const bodies = [
      (await as('admin').get(api('/settings'))).text,
      (await as('admin').get(api('/disclosure'))).text,
      (await as('emp').get(api('/status'))).text,
      (await as('superadmin').get(api('/platform/status'))).text,
    ];
    for (const body of bodies) expect(body).not.toContain(SECRET);
    const audits = JSON.stringify(await AuditLog.find({}).lean());
    expect(audits).not.toContain(SECRET);
  });
});
