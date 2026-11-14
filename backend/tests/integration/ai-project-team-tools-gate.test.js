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
 * Phase 8 Step 4, security: list_projects, get_project_overview, list_project_members, list_project_tasks and get_team driven ONLY
 * through the real internal callback route, as Python will call them.
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
const { LIVE_DATA_TOOL_NAMES, STEP3_TOOL_NAMES, STEP4_TOOL_NAMES, registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
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
const VALID = {
  list_projects: {},
  get_project_overview: { project: 'Apollo' },
  list_project_members: { project: 'Apollo' },
  list_project_tasks: { project: 'Apollo' },
  get_team: {},
};
const post = (token, body) => request(internal).post('/internal/ai/tools/execute').set('Authorization', `Bearer ${token}`).send(body);
const call = (token, name, args = VALID[name], callId = 'c1') => post(token, { callId, name, arguments: args });
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
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true, liveDataEnabled: true }, { organization: orgB._id, enabled: true, liveDataEnabled: true }]);

  const roster = [{ user: users.member._id, role: 'Contributor' }];
  apollo = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'apollo', name: 'Apollo', visibility: 'Organization', status: 'Active', members: roster, client: 'SECRET-CLIENT', budget: 424242, description: 'SECRET-DESCRIPTION', resourceLink: 'https://secret.example/x' });
  skunk = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'skunk', name: 'Skunkworks Private', visibility: 'Private', status: 'Active', members: roster });
  apolloB = await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'apollo-b', name: 'Apollo', visibility: 'Organization', status: 'Active' });
  teamA = await Team.create({ organization: orgA._id, name: 'Platform', createdBy: oid(), lead: users.manager._id, members: [users.member._id] });
  const due = new Date(`${todayIn(Date.now(), 'Asia/Kolkata')}T00:00:00.000Z`);
  const mk = (title, project, over = {}) => Task.create({ organization: orgA._id, project: project._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', dueDate: due, description: 'SECRET-DESCRIPTION', labels: ['SECRET-LABEL'], ...over });
  await mk('apollo-public', apollo);
  await mk('apollo-private', apollo, { visibility: 'Private' });
  await mk('skunk-task', skunk);
});

describe('registration', () => {
  test('the two Step 3 tools are unchanged and exactly the five Step 4 tools exist (eight in all with Step 5\'s workload tool); all read-only', () => {
    const defs = registry.listToolDefinitions({ permissions: ['USE_AI'] });
    expect(STEP3_TOOL_NAMES).toEqual(['list_my_tasks', 'list_my_schedule']);
    expect(STEP4_TOOL_NAMES).toEqual(['list_projects', 'get_project_overview', 'list_project_members', 'list_project_tasks', 'get_team']);
    expect(defs.map((d) => d.name).sort()).toEqual([...LIVE_DATA_TOOL_NAMES].sort());
    expect(defs).toHaveLength(8);
    for (const name of STEP4_TOOL_NAMES) expect(registry.findTool(name)).toMatchObject({ kind: 'read', permission: 'USE_AI' });
    for (const def of defs) expect(def.parameters.additionalProperties).toBe(false);
  });
});

describe('roles', () => {
  test('org-admin, admin, HR, manager and employee all get answers - and an administrator never gets the private project through ANY of the five tools', async () => {
    for (const key of ['admin', 'coadmin', 'hr', 'manager', 'outsider', 'owner', 'member']) {
      // eslint-disable-next-line no-await-in-loop
      const live = await startInFlight(users[key]);
      // eslint-disable-next-line no-await-in-loop
      const list = (await call(live.token, 'list_projects', { limit: 20 }, `${key}-1`).expect(200)).body.result;
      const names = list.data.map((p) => p.name);
      expect(names).toContain('Apollo');
      expect({ key, privateVisible: names.includes('Skunkworks Private') }).toEqual({ key, privateVisible: ['owner', 'member'].includes(key) });
      if (!['owner', 'member'].includes(key)) {
        for (const name of ['get_project_overview', 'list_project_members', 'list_project_tasks']) {
          // eslint-disable-next-line no-await-in-loop
          const r = (await call(live.token, name, { project: 'Skunkworks Private' }, `${key}-${name}`).expect(200)).body.result;
          expect({ key, name, outcome: r.outcome }).toEqual({ key, name, outcome: 'not_found' });
          // eslint-disable-next-line no-await-in-loop
          const byId = (await call(live.token, name, { project: String(skunk._id) }, `${key}-${name}-id`).expect(200)).body.result;
          expect(byId.outcome).toBe('not_found');
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await live.finish();
    }
  });

  test('team visibility through the gate: HR and admins see every team; a manager sees only the team they lead; an outsider none', async () => {
    const seen = async (key) => {
      const live = await startInFlight(users[key]);
      const body = (await call(live.token, 'get_team', {}, key).expect(200)).body.result;
      await live.finish();
      return body.teams.map((t) => t.name);
    };
    expect(await seen('hr')).toEqual(['Platform']);
    expect(await seen('manager')).toEqual(['Platform']);
    expect(await seen('outsider')).toEqual([]);
  });

  test('guests cannot use any of them; the super-admin cannot start an AI request or forge a callback', async () => {
    const guest = tokens.signCallbackToken({ userId: users.guest._id.toString(), orgId: orgA._id.toString(), requestKey: 'guest-req-0001' });
    for (const name of STEP4_TOOL_NAMES) expect((await call(guest, name)).status).toBeGreaterThanOrEqual(401);
    await expect(streamAiRequest({ actor: users.superadmin, feature: 'tools', messages: MESSAGES, toolBudget: true }).next()).rejects.toMatchObject({ statusCode: 403 });
    const forged = tokens.signCallbackToken({ userId: users.superadmin._id.toString(), orgId: orgA._id.toString(), requestKey: 'forged-req-0001' });
    for (const name of STEP4_TOOL_NAMES) expect((await call(forged, name)).status).toBe(401);
  });
});

describe('switches and account state are re-checked on every call', () => {
  test('AI off, live data off, blocked, deactivated, moved to another organization: the next call of EACH tool is refused with no data', async () => {
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
      expect((await call(live.token, 'list_projects', {}, 'before')).status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      await change();
      for (const name of STEP4_TOOL_NAMES) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(live.token, name, VALID[name], `after-${name}`);
        expect({ label, name, code: res.body.code }).toEqual({ label, name, code });
        expect(JSON.stringify(res.body)).not.toMatch(/Apollo|Skunkworks|Platform|SECRET/);
      }
      // eslint-disable-next-line no-await-in-loop
      await live.finish();
    }
  });
});

describe('arguments and isolation', () => {
  test('malformed and unexpected arguments are refused with field NAMES only, before any database query', async () => {
    const live = await startInFlight(users.member);
    const spy = jest.spyOn(Project, 'find');
    const bad = [
      ['list_projects', { status: 'Archived' }, ['status']],
      ['list_projects', { sort: 'name' }, ['sort']],
      ['list_projects', { name_contains: { $ne: null } }, ['name_contains']],
      ['list_projects', { organization: String(orgB._id) }, ['']],
      ['get_project_overview', {}, ['project']],
      ['get_project_overview', { project: { $ne: 'x' } }, ['project']],
      ['get_project_overview', { project: 'Apollo', userId: 'x' }, ['']],
      ['list_project_members', { project: '' }, ['project']],
      ['list_project_tasks', { project: 'Apollo', assignee: String(users.admin._id) }, ['assignee']],
      ['list_project_tasks', { project: 'Apollo', limit: 99 }, ['limit']],
      ['get_team', { team: 5 }, ['team']],
      ['get_team', { filter: {} }, ['']],
    ];
    for (const [name, args, fields] of bad) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(live.token, name, args, `bad-${Math.random()}`);
      expect({ name, status: res.status, code: res.body.code }).toEqual({ name, status: 400, code: 'AI_TOOL_BAD_ARGUMENTS' });
      expect(res.body.details.fields).toEqual(fields);
      expect(JSON.stringify(res.body)).not.toMatch(/\$ne|Archived/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('cross-tenant: another organization\'s user gets nothing of this one by id OR by name, through every tool; mixed tokens are refused', async () => {
    const live = await startInFlight(users.adminB);
    const missing = (await call(live.token, 'get_project_overview', { project: String(oid()) }, 'm').expect(200)).body.result;
    for (const name of ['get_project_overview', 'list_project_members', 'list_project_tasks']) {
      for (const ref of [String(apollo._id), String(skunk._id), 'Skunkworks Private']) {
        // eslint-disable-next-line no-await-in-loop
        const body = (await call(live.token, name, { project: ref }, `${name}-${ref}`).expect(200)).body.result;
        expect({ name, ref, outcome: body.outcome }).toEqual({ name, ref, outcome: 'not_found' });
        expect(JSON.stringify(body)).not.toMatch(/Skunkworks|SECRET/);
      }
    }
    // org B's OWN "Apollo" is found by name (names are per organization), and is not org A's
    const own = (await call(live.token, 'get_project_overview', { project: 'Apollo' }, 'own').expect(200)).body.result;
    expect(own.project.id).toBe(String(apolloB._id));
    expect(missing.outcome).toBe('not_found');
    expect((await call(live.token, 'get_team', {}, 't').expect(200)).body.result.teams).toEqual([]);
    expect((await call(live.token, 'get_team', { team: String(teamA._id) }, 't2').expect(200)).body.result.outcome).toBe('not_found');
    const mixed = tokens.signCallbackToken({ userId: users.member._id.toString(), orgId: orgB._id.toString(), requestKey: live.requestKey });
    expect((await call(mixed, 'list_projects', {})).status).toBe(401);
  });
});

describe('budgets and limits', () => {
  test('a repeated identical call is refused (409); the call budget is shared across all tools (429)', async () => {
    env.AI_TOOL_MAX_CALLS = 3;
    const live = await startInFlight(users.member);
    await call(live.token, 'list_projects', { limit: 5 }, 'a').expect(200);
    const dup = await call(live.token, 'list_projects', { limit: 5 }, 'b');
    expect([dup.status, dup.body.code]).toEqual([409, 'AI_TOOL_DUPLICATE']);
    await call(live.token, 'get_project_overview', VALID.get_project_overview, 'c').expect(200);
    await call(live.token, 'list_my_tasks', {}, 'd').expect(200); // a Step 3 tool uses the same budget
    const over = await call(live.token, 'get_team', {}, 'e');
    expect([over.status, over.body.code]).toEqual([429, 'AI_TOOL_BUDGET']);
  });

  test('a request with no tool budget cannot run any of them', async () => {
    const live = await startInFlight(users.member, { toolBudget: false });
    for (const name of STEP4_TOOL_NAMES) expect((await call(live.token, name)).body.code).toBe('AI_TOOL_NOT_FOUND');
  });

  test('an oversized list is trimmed to the byte budget (whole rows) and flagged, never refused', async () => {
    await Project.insertMany(Array.from({ length: 25 }, (_, i) => ({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: `big-${i}`, name: `${String(i).padStart(2, '0')}-${'P'.repeat(150)}`, visibility: 'Organization', status: 'Active' })));
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_projects', { limit: 20 }).expect(200);
    expect(res.body.result.summary.truncated).toBe(true);
    expect(res.body.result.summary.total).toBeGreaterThan(res.body.result.summary.count);
    expect(Buffer.byteLength(JSON.stringify(res.body.result))).toBeLessThanOrEqual(env.AI_TOOL_MAX_RESULT_BYTES);
  });

  test('a tool that returned a field outside its allowlist would be refused by the unchanged validator', async () => {
    const tool = registry.findTool('list_projects');
    const original = tool.run;
    registry.clearTools();
    registry.registerTool({ ...tool, run: async (ctx) => { const out = await original(ctx); out.data[0].client = 'SECRET-CLIENT'; return out; } });
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_projects', {});
    expect([res.status, res.body.code]).toEqual([502, 'AI_TOOL_RESULT_INVALID']);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('output and audit', () => {
  test('no description, client, budget, link, email, label or internal id appears in ANY of the five results', async () => {
    const live = await startInFlight(users.owner);
    for (const name of STEP4_TOOL_NAMES) {
      // eslint-disable-next-line no-await-in-loop
      const body = (await call(live.token, name, name === 'get_team' ? { team: 'Platform' } : VALID[name], name).expect(200)).body;
      expect({ name, leaked: /SECRET|424242|secret\.example|@|livekit|passwordHash|"_id"|description|client|budget/i.test(JSON.stringify(body)) }).toEqual({ name, leaked: false });
    }
  });

  test('every call is audited with counts and enum arguments only: the project/team/name text a model typed is never stored', async () => {
    const live = await startInFlight(users.member);
    await call(live.token, 'list_projects', { status: 'Active', sort: 'open_tasks', limit: 5, name_contains: 'SECRET-NAME-FILTER' }, 'a').expect(200);
    await call(live.token, 'get_project_overview', { project: 'SECRET-PROJECT-REFERENCE' }, 'b').expect(200);
    await call(live.token, 'list_project_tasks', { project: 'Apollo', status: 'all', due: 'today', assignee: 'me', limit: 5 }, 'c').expect(200);
    await call(live.token, 'get_team', { team: 'SECRET-TEAM-REFERENCE' }, 'd').expect(200);
    await call(live.token, 'list_project_members', { project: { $ne: 'x' } }, 'e');
    const rows = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.metadata.tool, r.metadata.status])).toEqual([
      ['list_projects', 'success'], ['get_project_overview', 'success'], ['list_project_tasks', 'success'], ['get_team', 'success'], ['list_project_members', 'refused'],
    ]);
    expect(rows[0].metadata).toMatchObject({ args: { status: 'Active', sort: 'open_tasks', limit: 5 }, argKeys: ['status', 'name_contains', 'sort', 'limit'] }); // schema order
    expect(rows[1].metadata.args ?? {}).toEqual({}); // (an empty object is not stored)
    expect(rows[1].metadata.argKeys).toEqual(['project']);
    expect(rows[2].metadata.args).toEqual({ status: 'all', due: 'today', assignee: 'me', limit: 5 });
    expect(rows[3].metadata.args ?? {}).toEqual({});
    expect(rows[3].metadata.argKeys).toEqual(['team']);
    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/SECRET|Apollo|Skunkworks|Platform|Member Tester|\$ne/);
  });
});

describe('cancellation and deadlines reach the queries', () => {
  test('when the REQUEST ends while list_projects is running it stops before its next query', async () => {
    const real = aiScope.resolveAiScope;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { await gate; return real(...a); });
    const projectQueries = jest.spyOn(Project, 'find');
    const taskQueries = jest.spyOn(Task, 'aggregate');
    const live = await startInFlight(users.member);
    const pending = callNow(live.token, 'list_projects', {});
    await until(() => aiScope.resolveAiScope.mock.calls.length === 1);
    await live.finish();
    release();
    expect((await pending).body.code).toBe('AI_TOOL_ABORTED');
    expect(projectQueries.mock.calls.length).toBeLessThanOrEqual(1); // only the scope query that was already inside the delayed step
    expect(taskQueries).not.toHaveBeenCalled(); // nothing after the abort
  });

  test('when the caller disconnects during list_project_tasks, no task query is started', async () => {
    const real = aiScope.findAiProject;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    jest.spyOn(aiScope, 'findAiProject').mockImplementation(async (...a) => { await gate; return real(...a); });
    const counts = jest.spyOn(Task, 'countDocuments');
    const live = await startInFlight(users.member);
    const req = post(live.token, { callId: 'c', name: 'list_project_tasks', arguments: { project: String(apollo._id) } });
    req.then(() => {}, () => {});
    await until(() => aiScope.findAiProject.mock.calls.length === 1);
    req.abort();
    await new Promise((r) => setTimeout(r, 150));
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(counts).not.toHaveBeenCalled();
  });

  test('the per-call deadline cuts a slow lookup off with the fixed timeout error and runs no later query', async () => {
    env.AI_TOOL_TIMEOUT_MS = 100;
    const real = aiScope.resolveAiScope;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { await new Promise((r) => setTimeout(r, 400)); return real(...a); });
    const projectQueries = jest.spyOn(Project, 'find');
    const taskQueries = jest.spyOn(Task, 'aggregate');
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_projects', {});
    expect([res.status, res.body.code]).toEqual([504, 'AI_TOOL_TIMEOUT']);
    await new Promise((r) => setTimeout(r, 450));
    expect(projectQueries.mock.calls.length).toBeLessThanOrEqual(1);
    expect(taskQueries).not.toHaveBeenCalled();
  });
});

describe('Step 3 tools are intact', () => {
  test('list_my_tasks and list_my_schedule still answer exactly as before', async () => {
    const live = await startInFlight(users.member);
    const tasks = (await call(live.token, 'list_my_tasks', {}, 'a').expect(200)).body.result;
    expect(tasks.data.map((t) => t.title).sort()).toEqual(['apollo-private', 'apollo-public', 'skunk-task']);
    expect(tasks.filters).toEqual({ status: 'open', due: null, relation: 'assigned' });
    const schedule = (await call(live.token, 'list_my_schedule', { range: 'today' }, 'b').expect(200)).body.result;
    expect(schedule.range.name).toBe('today');
    expect(schedule.data.map((e) => e.title).sort()).toEqual(['apollo-private', 'apollo-public', 'skunk-task']);
  });
});
