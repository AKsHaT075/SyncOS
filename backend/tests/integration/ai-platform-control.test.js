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
 * Steps 9B + 9C: the live-data guard BEFORE a tool budget opens, the deploy-time activation flag, and the runtime platform emergency switch
 * (read fresh, fail closed, rechecked at every callback and after a tool finishes). Real callback gate, real tools, a scripted engine.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const { make } = require('../../src/services/ai/aiService/errors');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiPlatformControl = require('../../src/models/AiPlatformControl');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const { createKeyPair } = require('../helpers/stubAiService');
const registry = require('../../src/services/ai/aiToolRegistry');
const aiScope = require('../../src/services/ai/tools/aiScope');
const tokens = require('../../src/services/ai/aiService/tokens');
const settings = require('../../src/services/ai/aiSettings.service');
const control = require('../../src/services/ai/aiPlatformControl.service');
const { executeTool } = require('../../src/services/ai/aiCallbacks.service');
const { registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const MSGS = [{ role: 'user', content: 'hi' }];
const done = { type: 'done', finishReason: 'stop', model: 'm', provider: 'groq', requestId: 'r', firstEventMs: 1 };
let org;
const savedFlag = env.AI_LIVE_TOOLS_ENABLED;
const pair = createKeyPair();

/** An engine whose chat() runs `script({ params, call })`; `call(name, args)` is a REAL tool callback through the real gate, as Python would make it. */
function scripted(script) {
  return {
    name: 'scripted',
    async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory' }; },
    async* chat(params) {
      const token = tokens.signCallbackToken({ ...params.identity });
      const call = (name, args = {}) => executeTool({ token, name, arguments: args, callId: `c-${Math.random()}`, signal: params.signal }).then((r) => ({ ok: true, result: r.result }), (e) => ({ ok: false, code: e.code, status: e.statusCode }));
      yield* script({ params, call });
    },
  };
}
const run = async (actor, options = {}) => {
  const events = [];
  try { for await (const e of streamAiRequest({ actor, feature: 'tools', messages: MSGS, ...options })) events.push(e); } catch (error) { return { error, events }; }
  return { events };
};
const open = async () => ({ reservations: await redis().keys('test:ai:q:*:r:*'), budgets: await redis().keys('test:ai:tool:*') });
const setControl = (fields) => AiPlatformControl.updateOne({ _id: 'platform' }, { $set: fields }, { upsert: true });

beforeAll(async () => { await connectTestDb(); await connectRedis(); });
afterAll(async () => {
  env.AI_LIVE_TOOLS_ENABLED = savedFlag;
  aiService.resetEngine(); registry.clearTools();
  await hub.shutdown();
  const keys = await redis().keys('test:ai*'); if (keys.length) await redis().del(keys);
  await disconnectTestDb(); await redis().quit();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  Object.assign(env, { AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100, AI_LIVE_TOOLS_ENABLED: true });
  registry.clearTools(); registerLiveDataTools();
  const keys = await redis().keys('test:ai:*'); if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiPlatformControl, AiUsageEvent, AuditLog, Organization, Project, User].map((m) => m.deleteMany({})));
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await createUser(org, 'guest', ROLES.GUEST);
  await createUser(org, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create({ organization: org._id, enabled: true, liveDataEnabled: true });
  await Project.create({ organization: org._id, createdBy: users.emp._id, owner: users.emp._id, slug: 'apollo', name: 'Apollo', visibility: 'Organization', status: 'Active', members: [{ user: users.emp._id, role: 'Owner' }] });
  aiService.setEngine(scripted(async function* () { yield { type: 'text', text: 'ok' }; yield { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false }; yield done; }));
  await Promise.all(['emp', 'guest', 'superadmin'].map(makeAgent));
});

describe('9B: the guard BEFORE a tool budget opens', () => {
  test.each([
    ['organization live data off', () => AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false }), C.LIVE_DATA_DISABLED],
    ['organization AI off', () => AiOrgSettings.updateOne({ organization: org._id }, { enabled: false }), C.DISABLED],
    ['platform live-tool switch', () => setControl({ liveToolsDisabled: true }), C.PLATFORM_LIVE_TOOLS_DISABLED],
    ['platform AI switch', () => setControl({ aiDisabled: true }), C.DISABLED],
    ['user blocked', () => User.updateOne({ _id: users.emp._id }, { orgBlocked: true }), 'ORG_BLOCKED'],
  ])('%s: a tool-budget request is refused before anything exists (no reservation, no budget, no usage row, no engine call)', async (_label, change, code) => {
    await change();
    const engineCalls = jest.spyOn(aiService.getEngine(), 'chat');
    const fresh = await User.findById(users.emp._id);
    const r = await run(fresh, { toolBudget: true });
    expect(r.error?.code).toBe(code);
    expect(engineCalls).not.toHaveBeenCalled();
    expect(await open()).toEqual({ reservations: [], budgets: [] });
    expect(await AiUsageEvent.countDocuments()).toBe(0);
  });

  test('the role is rechecked: a guest (no USE_AI) cannot get a budget; the identity comes from the fresh user, never from a request field', async () => {
    const r = await run(await User.findById(users.guest._id), { toolBudget: true });
    expect(r.error.statusCode).toBe(403);
    expect(await open()).toEqual({ reservations: [], budgets: [] });
  });

  test('a PLAIN request (no tool budget) is unaffected by the live-tool switch and by the organization live-data setting', async () => {
    await setControl({ liveToolsDisabled: true });
    await AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false });
    const r = await run(await User.findById(users.emp._id));
    expect(r.error).toBeUndefined();
    expect(r.events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
  });
});

describe('9B: eligibility (what a conversation may offer)', () => {
  const eligible = async () => settings.liveToolsEligibility({ actor: await User.findById(users.emp._id) });
  test('everything satisfied: eligible; the deploy-time flag OFF (the default) is never eligible', async () => {
    expect(await eligible()).toEqual({ eligible: true, reason: null });
    env.AI_LIVE_TOOLS_ENABLED = false;
    expect(await eligible()).toEqual({ eligible: false, reason: 'not_activated' });
  });
  test('the activation flag defaults to OFF', () => {
    jest.isolateModules(() => {
      const saved = process.env.AI_LIVE_TOOLS_ENABLED;
      delete process.env.AI_LIVE_TOOLS_ENABLED;
      expect(require('../../src/config/env').AI_LIVE_TOOLS_ENABLED).toBe(false);
      if (saved !== undefined) process.env.AI_LIVE_TOOLS_ENABLED = saved;
    });
  });
  test.each([
    ['org live data off', () => AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false }), C.LIVE_DATA_DISABLED],
    ['org AI off', () => AiOrgSettings.updateOne({ organization: org._id }, { enabled: false }), C.DISABLED],
    ['platform live switch', () => setControl({ liveToolsDisabled: true }), C.PLATFORM_LIVE_TOOLS_DISABLED],
    ['platform AI switch', () => setControl({ aiDisabled: true }), C.DISABLED],
    ['blocked user', () => User.updateOne({ _id: users.emp._id }, { orgBlocked: true }), 'ORG_BLOCKED'],
    ['role without USE_AI', () => User.updateOne({ _id: users.emp._id }, { role: ROLES.GUEST }), 'FORBIDDEN'],
  ])('%s: not eligible (reason %s)', async (_l, change, reason) => {
    await change();
    expect(await eligible()).toEqual({ eligible: false, reason });
  });
});

describe('9C: the platform emergency switch', () => {
  test('only a super-admin can read or change it; the change is audited with flags and a fixed reason, nothing else', async () => {
    for (const key of ['emp', 'guest']) {
      expect([401, 403, 404]).toContain((await as(key).put('/api/v1/ai/platform/control').send({ liveToolsDisabled: true })).status); // eslint-disable-line no-await-in-loop
      expect([401, 403, 404]).toContain((await as(key).get('/api/v1/ai/platform/control')).status); // eslint-disable-line no-await-in-loop
    }
    expect(await AiPlatformControl.countDocuments()).toBe(0);
    const res = await as('superadmin').put('/api/v1/ai/platform/control').send({ liveToolsDisabled: true, reason: 'incident' }).expect(200);
    expect(res.body.control).toEqual({ aiDisabled: false, liveToolsDisabled: true, reason: 'incident', readable: true });
    expect((await as('superadmin').get('/api/v1/ai/platform/control').expect(200)).body.control.liveToolsDisabled).toBe(true);
    const audit = await AuditLog.find({ action: AUDIT_EVENTS.AI_PLATFORM_CONTROL_CHANGED }).lean();
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ aiDisabled: false, liveToolsDisabled: true, reason: 'incident', previous: { aiDisabled: false, liveToolsDisabled: false } });
    expect(String(audit[0].user)).toBe(String(users.superadmin._id));
  });

  test('the body is strict: unknown fields, free-text reasons and empty changes are refused', async () => {
    const put = (body) => as('superadmin').put('/api/v1/ai/platform/control').send(body);
    for (const bad of [{}, { liveToolsDisabled: 'yes' }, { liveToolsDisabled: true, reason: 'because I said so' }, { liveToolsDisabled: true, organization: 'x' }]) expect((await put(bad)).status).toBe(400); // eslint-disable-line no-await-in-loop
    expect(await AiPlatformControl.countDocuments()).toBe(0);
  });

  test('FAIL CLOSED: if the switch cannot be read, AI and live tools are both treated as OFF', async () => {
    jest.spyOn(AiPlatformControl, 'findOne').mockReturnValue({ maxTimeMS: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });
    expect(await control.getControl()).toMatchObject({ aiDisabled: true, liveToolsDisabled: true, readable: false });
    await expect(settings.assertAiAvailable({ actor: await User.findById(users.emp._id) })).rejects.toMatchObject({ code: C.DISABLED });
    expect(await settings.liveToolsEligibility({ actor: await User.findById(users.emp._id) })).toMatchObject({ eligible: false });
    await expect(control.updateControl({ actor: users.superadmin, changes: { liveToolsDisabled: false } })).rejects.toMatchObject({ statusCode: 503 }); // and it never writes blind
  });

  test('a missing row is the normal state: nothing is switched off', async () => {
    expect(await control.getControl()).toMatchObject({ aiDisabled: false, liveToolsDisabled: false, readable: true });
    expect((await settings.liveToolsEligibility({ actor: await User.findById(users.emp._id) })).eligible).toBe(true);
  });

  test('IN FLIGHT: the very next tool callback is refused and nothing further runs; organization settings keep working independently', async () => {
    let first; let second;
    aiService.setEngine(scripted(async function* ({ call }) {
      first = await call('list_projects');
      await setControl({ liveToolsDisabled: true }); // the operator flips the switch mid-request
      second = await call('list_projects');
      yield { type: 'text', text: 'x' };
      yield done;
    }));
    await run(await User.findById(users.emp._id), { toolBudget: true });
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first.result)).toContain('Apollo');
    expect(second).toMatchObject({ ok: false, code: C.PLATFORM_LIVE_TOOLS_DISABLED, status: 403 });
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED, 'metadata.status': 'success' })).toBe(1); // only the first call executed
    expect(await open()).toEqual({ reservations: [], budgets: [] });
  });

  test('IN FLIGHT: a tool that FINISHES after the flip returns nothing (its result is discarded)', async () => {
    const real = aiScope.resolveAiScope;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { const out = await real(...a); await setControl({ liveToolsDisabled: true }); return out; });
    let outcome;
    aiService.setEngine(scripted(async function* ({ call }) { outcome = await call('list_projects'); yield { type: 'text', text: 'x' }; yield done; }));
    await run(await User.findById(users.emp._id), { toolBudget: true });
    expect(outcome).toMatchObject({ ok: false, code: C.PLATFORM_LIVE_TOOLS_DISABLED });
    expect(JSON.stringify(outcome)).not.toContain('Apollo');
  });

  test('the AI-wide switch refuses callbacks too, and switching back restores service immediately (no cache)', async () => {
    await setControl({ aiDisabled: true });
    let blocked; let restored;
    aiService.setEngine(scripted(async function* ({ call }) { blocked = await call('list_projects'); await setControl({ aiDisabled: false, liveToolsDisabled: false }); restored = await call('get_team'); yield { type: 'text', text: 'x' }; yield done; }));
    // the request itself must start while the switch is OFF, so flip it just after admission: start with it off, engine flips it on at the first call
    await setControl({ aiDisabled: false });
    aiService.setEngine(scripted(async function* ({ call }) {
      await setControl({ aiDisabled: true });
      blocked = await call('list_projects');
      await setControl({ aiDisabled: false });
      restored = await call('get_team');
      yield { type: 'text', text: 'x' }; yield done;
    }));
    await run(await User.findById(users.emp._id), { toolBudget: true });
    expect(blocked).toMatchObject({ ok: false, code: C.DISABLED });
    expect(restored.ok).toBe(true);
  });

  test('an error between the switch and the guard leaves no open budget: a refused request, then a normal one, both clean', async () => {
    await setControl({ liveToolsDisabled: true });
    expect((await run(await User.findById(users.emp._id), { toolBudget: true })).error.code).toBe(C.PLATFORM_LIVE_TOOLS_DISABLED);
    await setControl({ liveToolsDisabled: false });
    expect((await run(await User.findById(users.emp._id), { toolBudget: true })).error).toBeUndefined();
    expect(await open()).toEqual({ reservations: [], budgets: [] });
  });
});
