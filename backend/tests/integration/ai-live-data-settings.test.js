jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/** Phase 8, Step 0: the organization-level `liveDataEnabled` switch (separate from `enabled`, default off). */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_DISCLOSURE, AI_LIVE_DATA_DISCLOSURE } = require('../../src/constants/ai.constants');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const { createFakeProvider } = require('../helpers/fakeAiProvider');
const { assertAiAvailable, assertLiveDataAvailable } = require('../../src/services/ai/aiSettings.service');

const { users, createUser, makeAgent, as } = createHarness();
const KEYS = ['admin', 'hr', 'manager', 'emp', 'guest', 'adminB', 'empB'];
const fake = createFakeProvider();
aiService.setEngine(fake);
const api = (path = '') => `/api/v1/ai${path}`;
const oid = () => new mongoose.Types.ObjectId();
const enableAi = (key = 'admin') => as(key).put(api('/settings')).send({ enabled: true, acceptDisclosureVersion: AI_DISCLOSURE.version });
const enableLive = (key = 'admin', version = AI_LIVE_DATA_DISCLOSURE.version) => as(key).put(api('/settings')).send({ liveDataEnabled: true, acceptLiveDataDisclosureVersion: version });
let orgA; let orgB;

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all(KEYS.map(makeAgent));
});
afterAll(async () => {
  await hub.shutdown();
  await disconnectTestDb();
  await createRedisClient().quit();
});
beforeEach(async () => {
  fake.setConfigured(true);
  env.AI_GLOBAL_ENABLED = true;
  await Promise.all([AiOrgSettings.deleteMany({}), AuditLog.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
});

describe('default and backward compatibility', () => {
  test('live data is OFF for an organization with no settings row, and reading never creates one', async () => {
    const settings = (await as('admin').get(api('/settings')).expect(200)).body.settings;
    expect(settings.liveDataEnabled).toBe(false);
    expect(settings.liveData.disclosure).toMatchObject({ acceptedVersion: null, currentVersion: AI_LIVE_DATA_DISCLOSURE.version, needsReacceptance: false });
    expect(await AiOrgSettings.countDocuments()).toBe(0);
  });

  test('a pre-Phase-8 row (AI on, no live-data fields at all) is read as live data OFF - no migration needed', async () => {
    await AiOrgSettings.collection.insertOne({ organization: orgA._id, enabled: true, disclosure: { version: AI_DISCLOSURE.version }, quotas: {} }); // raw insert: the new fields do not exist
    const raw = await AiOrgSettings.collection.findOne({ organization: orgA._id });
    expect('liveDataEnabled' in raw).toBe(false);
    expect((await as('admin').get(api('/settings')).expect(200)).body.settings.liveDataEnabled).toBe(false);
    expect((await as('emp').get(api('/status')).expect(200)).body.status).toMatchObject({ ready: true, liveDataEnabled: false });
    await expect(assertLiveDataAvailable({ actor: users.emp })).rejects.toMatchObject({ statusCode: 403, code: 'AI_LIVE_DATA_DISABLED' });
    await expect(assertAiAvailable({ actor: users.emp })).resolves.toMatchObject({ liveDataEnabled: false }); // ordinary AI is unaffected
  });

  test('enabling AI does NOT enable live data', async () => {
    await enableAi().expect(200);
    const row = await AiOrgSettings.findOne({ organization: orgA._id }).lean();
    expect(row.liveDataEnabled).toBe(false);
    expect((await as('emp').get(api('/status'))).body.status.liveDataEnabled).toBe(false);
  });
});

describe('turning live data on', () => {
  test('needs AI on first', async () => {
    const res = await enableLive();
    expect([res.status, res.body.code]).toEqual([409, 'AI_LIVE_DATA_REQUIRES_AI']);
    expect(await AiOrgSettings.countDocuments()).toBe(0);
  });

  test('needs ITS OWN disclosure (the AI disclosure is not enough), and the exact current version', async () => {
    await enableAi().expect(200);
    for (const body of [{ liveDataEnabled: true }, { liveDataEnabled: true, acceptLiveDataDisclosureVersion: AI_DISCLOSURE.version }, { liveDataEnabled: true, acceptLiveDataDisclosureVersion: 'v0-old' }]) {
      const res = await as('admin').put(api('/settings')).send(body);
      expect([res.status, res.body.code]).toEqual([400, 'DISCLOSURE_REQUIRED']);
      expect(res.body.details).toEqual({ requiredVersion: AI_LIVE_DATA_DISCLOSURE.version });
    }
    expect((await AiOrgSettings.findOne({ organization: orgA._id }).lean()).liveDataEnabled).toBe(false);
  });

  test('with AI on and the disclosure accepted it switches on, records who accepted what, and is audited', async () => {
    await enableAi().expect(200);
    const res = await enableLive().expect(200);
    expect(res.body.settings).toMatchObject({ enabled: true, liveDataEnabled: true });
    expect(res.body.settings.liveData.disclosure).toMatchObject({ acceptedVersion: AI_LIVE_DATA_DISCLOSURE.version, acceptedBy: users.admin._id.toString(), needsReacceptance: false });
    expect((await as('emp').get(api('/status'))).body.status.liveDataEnabled).toBe(true);
    const audit = await AuditLog.findOne({ action: AUDIT_EVENTS.AI_LIVE_DATA_ENABLED }).lean();
    expect(audit).toMatchObject({ organization: orgA._id, user: users.admin._id, metadata: { disclosureVersion: AI_LIVE_DATA_DISCLOSURE.version } });
    await expect(assertLiveDataAvailable({ actor: users.emp })).resolves.toMatchObject({ liveDataEnabled: true });
  });

  test('the live-data disclosure is served next to the AI disclosure, and does not change the AI disclosure version', async () => {
    const body = (await as('admin').get(api('/disclosure')).expect(200)).body;
    expect(body.disclosure.version).toBe(AI_DISCLOSURE.version);
    expect(body.liveDataDisclosure).toMatchObject({ version: AI_LIVE_DATA_DISCLOSURE.version, provider: 'Groq' });
    expect(body.liveDataDisclosure.points.join(' ')).toMatch(/Organization admins do not gain access to other members' private projects or tasks/);
    expect((await as('admin').get(api('/settings'))).body.liveDataDisclosure.version).toBe(AI_LIVE_DATA_DISCLOSURE.version);
  });
});

describe('turning live data off', () => {
  beforeEach(async () => { await enableAi().expect(200); await enableLive().expect(200); });

  test('switching it off takes effect on the very next gate check, and is audited; AI itself stays on', async () => {
    await expect(assertLiveDataAvailable({ actor: users.emp })).resolves.toBeTruthy();
    const res = await as('admin').put(api('/settings')).send({ liveDataEnabled: false }).expect(200);
    expect(res.body.settings).toMatchObject({ enabled: true, liveDataEnabled: false });
    await expect(assertLiveDataAvailable({ actor: users.emp })).rejects.toMatchObject({ code: 'AI_LIVE_DATA_DISABLED' });
    await expect(assertAiAvailable({ actor: users.emp })).resolves.toBeTruthy();
    expect(await AuditLog.findOne({ action: AUDIT_EVENTS.AI_LIVE_DATA_DISABLED }).lean()).toMatchObject({ metadata: { reason: 'admin' } });
  });

  test('turning AI off ALSO turns live data off, and turning AI back on does not silently restore it', async () => {
    await as('admin').put(api('/settings')).send({ enabled: false }).expect(200);
    const off = await AiOrgSettings.findOne({ organization: orgA._id }).lean();
    expect(off).toMatchObject({ enabled: false, liveDataEnabled: false });
    expect(await AuditLog.findOne({ action: AUDIT_EVENTS.AI_LIVE_DATA_DISABLED }).lean()).toMatchObject({ metadata: { reason: 'ai_disabled' } });
    await enableAi().expect(200);
    expect((await AiOrgSettings.findOne({ organization: orgA._id }).lean()).liveDataEnabled).toBe(false);
    await expect(assertLiveDataAvailable({ actor: users.emp })).rejects.toMatchObject({ code: 'AI_LIVE_DATA_DISABLED' });
  });

  test('an inconsistent row (live data on, AI off) never reads as live data on', async () => {
    await AiOrgSettings.updateOne({ organization: orgA._id }, { $set: { enabled: false } }); // bypasses the service on purpose
    await expect(assertLiveDataAvailable({ actor: users.emp })).rejects.toMatchObject({ statusCode: 403 });
    expect((await as('admin').get(api('/settings'))).body.settings.liveDataEnabled).toBe(false);
  });

  test('re-sending the same state is a no-op: no audit row, no change', async () => {
    const before = await AuditLog.countDocuments();
    await enableLive().expect(200);
    expect(await AuditLog.countDocuments()).toBe(before);
  });
});

describe('who may change it, and isolation', () => {
  test('only org-admin / admin (MANAGE_AI); hr, manager, employee, guest and super-admin cannot', async () => {
    await enableAi().expect(200);
    for (const key of ['hr', 'manager', 'emp', 'guest']) {
      expect((await enableLive(key)).status).toBe(403);
    }
    expect((await AiOrgSettings.findOne({ organization: orgA._id }).lean()).liveDataEnabled).toBe(false);
  });

  test('one organization\'s switch never affects another', async () => {
    await enableAi().expect(200);
    await enableLive().expect(200);
    await expect(assertLiveDataAvailable({ actor: users.empB })).rejects.toMatchObject({ statusCode: 403 });
    expect((await as('adminB').get(api('/settings'))).body.settings.liveDataEnabled).toBe(false);
  });

  test('an update must name something; unknown fields are rejected', async () => {
    await as('admin').put(api('/settings')).send({}).expect(400);
    await as('admin').put(api('/settings')).send({ liveDataEnabled: true, organization: orgB._id.toString() }).expect(400);
  });

  test('a guest never passes the live-data gate even if the organization switched it on', async () => {
    await enableAi().expect(200);
    await enableLive().expect(200);
    await expect(assertLiveDataAvailable({ actor: users.guest })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
});
