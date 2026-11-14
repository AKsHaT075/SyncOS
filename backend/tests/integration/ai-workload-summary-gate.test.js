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
 * Phase 8 Step 5, security: get_workload_summary driven ONLY through the real internal callback route, as Python will call it.
 */
const mongoose = require('mongoose');
const request = require('supertest');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const registry = require('../../src/services/ai/aiToolRegistry');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { LIVE_DATA_TOOL_NAMES, STEP5_TOOL_NAMES, registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { todayIn } = require('../../src/utils/aiDateRanges');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const internal = createInternalApp();
const redis = () => createRedisClient();
const oid = () => new mongoose.Types.ObjectId();
const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_TOOL_MAX_CALLS', 'AI_TOOL_TIMEOUT_MS'];
const saved = {};
const MESSAGES = [{ role: 'user', content: 'hi' }];
let orgA; let orgB; let apollo; let skunk; let apolloB; let teamA; let runs = [];

// One valid argument set per tool (the project is referred to by NAME, as a model usually would).
const VALID = { get_workload_summary: { scope: 'me' } };
const post = (token, body) => request(internal).post('/internal/ai/tools/execute').set('Authorization', `Bearer ${token}`).send(body);
const call = (token, name, args = VALID.get_workload_summary, callId = 'c1') => post(token, { callId, name, arguments: args });
const callNow = (...a) => call(...a).then((r) => r);
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
    } catch { /* aborted at the end */ }
  })();
  runs.push({ controller, run });
  await until(() => stub.requests.length === before + 1);
  const requestKey = stub.requests[before].claims.jti;
  return { requestKey, token: tokens.signCallbackToken({ userId: actor._id.toString(), orgId: actor.organization.toString(), requestKey }), finish: async () => { controller.abort(); await run; } };
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
  registry.clearTools();
  await stub.stop();
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const { controller, run } of runs) {
    controller.abort();
    // eslint-disable-next-line no-await-in-loop
    await run;
  }
});

beforeEach(async () => {
  runs = [];
  stub.reset();
  aiService.resetEngine();
  Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_GLOBAL_ENABLED: true, AI_TOOL_MAX_CALLS: 14, AI_TOOL_TIMEOUT_MS: 8000 });
  registry.clearTools();
  registerLiveDataTools();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiUsageEvent, AuditLog, Organization, Project, Task, Team, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'coadmin', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'member', ROLES.EMPLOYEE);
  await createUser(orgA, 'outsider', ROLES.EMPLOYEE);
  await createUser(orgA, 'extra', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true, liveDataEnabled: true }, { organization: orgB._id, enabled: true, liveDataEnabled: true }]);

  const roster = [{ user: users.member._id, role: 'Contributor' }];
  apollo = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'apollo', name: 'Apollo', visibility: 'Organization', status: 'Active', members: roster, client: 'SECRET-CLIENT', budget: 424242, description: 'SECRET-DESCRIPTION', resourceLink: 'https://secret.example/x' });
  skunk = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'skunk', name: 'Skunkworks Private', visibility: 'Private', status: 'Active', members: roster });
  apolloB = await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'apollo-b', name: 'Apollo', visibility: 'Organization', status: 'Active' });
  teamA = await Team.create({ organization: orgA._id, name: 'Platform', createdBy: oid(), lead: users.manager._id, members: [users.member._id, users.owner._id, users.outsider._id, users.extra._id] });
  const due = new Date(`${todayIn(Date.now(), 'Asia/Kolkata')}T00:00:00.000Z`);
  const mk = (title, project, over = {}) => Task.create({ organization: orgA._id, project: project._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', dueDate: due, description: 'SECRET-DESCRIPTION', labels: ['SECRET-LABEL'], ...over });
  await mk('apollo-public', apollo);
  await mk('apollo-private', apollo, { visibility: 'Private' });
  await mk('skunk-task', skunk);
});

const W = 'get_workload_summary';
const KEYS = ['asOf', 'basis', 'cancelledTasks', 'complete', 'completedTasks', 'dueToday', 'inProgressTasks', 'inReviewTasks', 'noDueDate', 'openTasks', 'outcome', 'overdueTasks', 'peopleInScope', 'reason', 'scope', 'todoTasks', 'totalTasks'];

describe('registration', () => {
  test('exactly eight tools: Steps 3 and 4 unchanged plus get_workload_summary; read-only, strict, USE_AI', () => {
    const defs = registry.listToolDefinitions({ permissions: ['USE_AI'] });
    expect(STEP5_TOOL_NAMES).toEqual([W]);
    expect(defs).toHaveLength(8);
    expect(defs.map((d) => d.name).sort()).toEqual([...LIVE_DATA_TOOL_NAMES].sort());
    expect(registry.findTool(W)).toMatchObject({ kind: 'read', permission: 'USE_AI', auditFields: ['scope'] });
    for (const def of defs) expect(def.parameters.additionalProperties).toBe(false);
    registerLiveDataTools();
    expect(registry.listToolDefinitions({ permissions: ['USE_AI'] })).toHaveLength(8); // idempotent
    expect(registry.listToolDefinitions({ permissions: [] })).toHaveLength(0);
  });
});

describe('roles through the gate', () => {
  test('every role gets the fixed result shape; scopes follow the matrix; nothing identifying appears', async () => {
    const matrix = {
      admin: { me: 'ok', my_team: 'no_team_led', organization: 'ok' },
      coadmin: { me: 'ok', my_team: 'no_team_led', organization: 'ok' },
      hr: { me: 'ok', my_team: 'role_not_permitted', organization: 'ok' },
      manager: { me: 'ok', my_team: 'ok', organization: 'role_not_permitted' },
      outsider: { me: 'ok', my_team: 'role_not_permitted', organization: 'role_not_permitted' },
    };
    for (const [key, scopes] of Object.entries(matrix)) {
      // eslint-disable-next-line no-await-in-loop
      const live = await startInFlight(users[key]);
      for (const [scope, expected] of Object.entries(scopes)) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(live.token, W, { scope }, `${key}-${scope}`).expect(200);
        const r = res.body.result;
        expect({ key, scope, got: r.outcome === 'ok' ? 'ok' : r.reason }).toEqual({ key, scope, got: expected });
        expect(Object.keys(r).sort()).toEqual(KEYS);
        expect(JSON.stringify(res.body)).not.toMatch(/apollo|skunk|SECRET|Tester|@acme|Platform|[a-f0-9]{24}/i);
      }
      // eslint-disable-next-line no-await-in-loop
      await live.finish();
    }
  });

  test('an administrator\'s organization total excludes the private project and the private task; HR never exceeds it', async () => {
    const live = await startInFlight(users.admin);
    const org = (await call(live.token, W, { scope: 'organization' }, 'o').expect(200)).body.result;
    expect(org.totalTasks).toBe(1); // apollo-public only (apollo-private is a private task, skunk-task is in a private project)
    const hrLive = await startInFlight(users.hr);
    const hr = (await call(hrLive.token, W, { scope: 'organization' }, 'h').expect(200)).body.result;
    expect(hr.totalTasks).toBeLessThanOrEqual(org.totalTasks);
    const member = await startInFlight(users.member);
    expect((await call(member.token, W, { scope: 'me' }, 'm').expect(200)).body.result.totalTasks).toBe(3); // the member is attached to all three
  });

  test('guests and the super-admin cannot use it or forge a callback', async () => {
    const guest = tokens.signCallbackToken({ userId: users.guest._id.toString(), orgId: orgA._id.toString(), requestKey: 'guest-req-0001' });
    expect((await call(guest, W)).status).toBeGreaterThanOrEqual(401);
    const forged = tokens.signCallbackToken({ userId: users.superadmin._id.toString(), orgId: orgA._id.toString(), requestKey: 'forged-req-0001' });
    expect((await call(forged, W)).status).toBe(401);
  });
});

describe('switches and account state are re-checked on every call', () => {
  test('AI off, live data off, blocked, deactivated, moved: the next call is refused with no numbers', async () => {
    const cases = [
      ['AI disabled', () => AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false }), 'AI_DISABLED'],
      ['live data disabled', () => AiOrgSettings.updateOne({ organization: orgA._id }, { liveDataEnabled: false }), 'AI_LIVE_DATA_DISABLED'],
      ['blocked', () => User.updateOne({ _id: users.member._id }, { orgBlocked: true }), 'AI_CALLBACK_UNAUTHORIZED'],
      ['deactivated', () => User.updateOne({ _id: users.member._id }, { isActive: false }), 'AI_CALLBACK_UNAUTHORIZED'],
      ['moved organization', () => User.updateOne({ _id: users.member._id }, { organization: orgB._id }), 'AI_CALLBACK_UNAUTHORIZED'],
    ];
    for (const [label, change, code] of cases) {
      // eslint-disable-next-line no-await-in-loop
      await AiOrgSettings.updateMany({}, { enabled: true, liveDataEnabled: true });
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne({ _id: users.member._id }, { orgBlocked: false, isActive: true, organization: orgA._id });
      // eslint-disable-next-line no-await-in-loop
      const live = await startInFlight(users.member);
      // eslint-disable-next-line no-await-in-loop
      expect((await call(live.token, W, { scope: 'me' }, 'before')).status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      await change();
      // eslint-disable-next-line no-await-in-loop
      const res = await call(live.token, W, { scope: 'me' }, 'after');
      expect({ label, code: res.body.code }).toEqual({ label, code });
      expect(res.body.result).toBeUndefined();
      // eslint-disable-next-line no-await-in-loop
      await live.finish();
    }
  });

  test('a role change is honoured on the next call (an administrator demoted to employee loses organization)', async () => {
    const live = await startInFlight(users.admin);
    expect((await call(live.token, W, { scope: 'me' }, 'a').expect(200)).body.result.outcome).toBe('ok');
    await User.updateOne({ _id: users.admin._id }, { role: ROLES.EMPLOYEE });
    const after = (await call(live.token, W, { scope: 'organization' }, 'b').expect(200)).body.result;
    expect(after).toMatchObject({ outcome: 'not_available', reason: 'role_not_permitted', totalTasks: null });
  });
});

describe('arguments and isolation', () => {
  test('ids, filters, pipelines, roles and unknown scopes are refused with field NAMES only, before any query', async () => {
    const live = await startInFlight(users.admin);
    const spy = jest.spyOn(Task, 'aggregate');
    const bad = [
      [{ scope: 'everyone' }, ['scope']],
      [{ scope: { $ne: 'me' } }, ['scope']],
      [{ organization: String(orgB._id) }, ['']],
      [{ user: String(users.member._id) }, ['']],
      [{ team: String(teamA._id) }, ['']],
      [{ filter: { status: 'Todo' } }, ['']],
      [{ pipeline: [{ $match: {} }] }, ['']],
      [{ role: 'admin' }, ['']],
    ];
    for (const [args, fields] of bad) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(live.token, W, args, `bad-${Math.random()}`);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: 'AI_TOOL_BAD_ARGUMENTS' });
      expect(res.body.details.fields).toEqual(fields);
      expect(JSON.stringify(res.body)).not.toMatch(/\$ne|everyone/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('cross-tenant: another organization\'s user never sees this organization\'s numbers, and the tokens cannot be mixed', async () => {
    const live = await startInFlight(users.adminB);
    const mine = (await call(live.token, W, { scope: 'me' }, 'm').expect(200)).body.result;
    expect(mine.totalTasks).toBe(0); // adminB is assigned nothing; org A's three tasks are not counted
    const org = (await call(live.token, W, { scope: 'organization' }, 'o').expect(200)).body.result;
    expect(org).toMatchObject({ outcome: 'not_available', reason: 'group_too_small', totalTasks: null });
    const mixed = tokens.signCallbackToken({ userId: users.member._id.toString(), orgId: orgB._id.toString(), requestKey: live.requestKey });
    expect((await call(mixed, W)).status).toBe(401);
  });
});

describe('budgets and limits', () => {
  test('a repeated identical call is refused (409); the budget is shared with the other tools (429)', async () => {
    env.AI_TOOL_MAX_CALLS = 3;
    const live = await startInFlight(users.member);
    await call(live.token, W, { scope: 'me' }, 'a').expect(200);
    const dup = await call(live.token, W, { scope: 'me' }, 'b');
    expect([dup.status, dup.body.code]).toEqual([409, 'AI_TOOL_DUPLICATE']);
    await call(live.token, 'list_my_tasks', {}, 'c').expect(200);
    await call(live.token, 'get_team', {}, 'd').expect(200);
    const over = await call(live.token, W, { scope: 'organization' }, 'e');
    expect([over.status, over.body.code]).toEqual([429, 'AI_TOOL_BUDGET']);
  });

  test('a request with no tool budget cannot run it', async () => {
    const live = await startInFlight(users.member, { toolBudget: false });
    expect((await call(live.token, W)).body.code).toBe('AI_TOOL_NOT_FOUND');
  });

  test('a tool that added a field outside its allowlist (a per-person breakdown) would be refused by the unchanged validator', async () => {
    const tool = registry.findTool(W);
    const original = tool.run;
    registry.clearTools();
    registry.registerTool({ ...tool, run: async (ctx) => ({ ...(await original(ctx)), byAssignee: [{ name: 'SECRET-PERSON', open: 3 }] }) });
    const live = await startInFlight(users.admin);
    const res = await call(live.token, W, { scope: 'organization' });
    expect([res.status, res.body.code]).toEqual([502, 'AI_TOOL_RESULT_INVALID']);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('audit', () => {
  test('a call is audited with the scope enum only; no counts, names or ids are stored', async () => {
    const live = await startInFlight(users.admin);
    await call(live.token, W, { scope: 'organization' }, 'a').expect(200);
    await call(live.token, W, { scope: 'bogus-SECRET-SCOPE' }, 'b');
    const rows = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.metadata.tool, r.metadata.status])).toEqual([[W, 'success'], [W, 'refused']]);
    expect(rows[0].metadata).toMatchObject({ args: { scope: 'organization' }, argKeys: ['scope'] });
    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/SECRET|totalTasks|openTasks|apollo|Tester/i);
  });
});

describe('cancellation and deadlines reach the query', () => {
  test('when the REQUEST ends while the summary is being prepared, no task query is started', async () => {
    const real = aiScope.resolveAiScope;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { await gate; return real(...a); });
    const aggregates = jest.spyOn(Task, 'aggregate');
    const live = await startInFlight(users.admin);
    const pending = callNow(live.token, W, { scope: 'organization' });
    await until(() => aiScope.resolveAiScope.mock.calls.length === 1);
    await live.finish();
    release();
    expect((await pending).body.code).toBe('AI_TOOL_ABORTED');
    expect(aggregates).not.toHaveBeenCalled();
  });

  test('the per-call deadline cuts a slow lookup off with the fixed timeout error and no later query runs', async () => {
    env.AI_TOOL_TIMEOUT_MS = 100;
    const real = aiScope.resolveAiScope;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { await new Promise((r) => setTimeout(r, 400)); return real(...a); });
    const aggregates = jest.spyOn(Task, 'aggregate');
    const live = await startInFlight(users.member);
    const res = await call(live.token, W, { scope: 'me' });
    expect([res.status, res.body.code]).toEqual([504, 'AI_TOOL_TIMEOUT']);
    await new Promise((r) => setTimeout(r, 450));
    expect(aggregates).not.toHaveBeenCalled();
  });
});
