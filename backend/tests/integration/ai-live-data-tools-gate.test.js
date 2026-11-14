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
 * Phase 8 Step 3, security: list_my_tasks and list_my_schedule driven ONLY through the real internal callback route
 * (token -> live user -> AI + live-data gate -> registry -> budget -> run -> allowlist -> audit), as Python will call them.
 */
const fs = require('fs');
const path = require('path');
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
const Meeting = require('../../src/models/Meeting');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const registry = require('../../src/services/ai/aiToolRegistry');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { LIVE_DATA_TOOL_NAMES, STEP3_TOOL_NAMES, STEP4_TOOL_NAMES, registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { todayIn } = require('../../src/utils/aiDateRanges');
const { createApp } = require('../../src/app');
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
let orgA; let orgB; let pOrg; let pPriv; let runs = []; let todayDue;

const post = (token, body) => request(internal).post('/internal/ai/tools/execute').set('Authorization', `Bearer ${token}`).send(body);
const call = (token, name, args = {}, callId = 'c1') => post(token, { callId, name, arguments: args });
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

async function startInFlight(actor) {
  stub.enqueue({ frames: [{ type: 'text', text: 'hello' }], hangAfterFrames: true });
  const before = stub.requests.length;
  const controller = new AbortController();
  const run = (async () => {
    try {
      for await (const e of streamAiRequest({ actor, feature: 'tools', messages: MESSAGES, toolBudget: true, signal: controller.signal })) void e;
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
  Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_GLOBAL_ENABLED: true, AI_TOOL_MAX_CALLS: 5, AI_TOOL_TIMEOUT_MS: 8000 });
  registry.clearTools();
  registerLiveDataTools();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiUsageEvent, AuditLog, Meeting, Organization, Project, Task, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'coadmin', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'member', ROLES.EMPLOYEE);
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true, liveDataEnabled: true }, { organization: orgB._id, enabled: true, liveDataEnabled: true }]);

  pOrg = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'a', name: 'Apollo', visibility: 'Organization', status: 'Active', members: [{ user: users.member._id, role: 'Contributor' }] });
  pPriv = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'p', name: 'Skunkworks Private', visibility: 'Private', status: 'Active', members: [{ user: users.member._id, role: 'Contributor' }] });
  todayDue = new Date(`${todayIn(Date.now(), 'Asia/Kolkata')}T00:00:00.000Z`);
  const mk = (title, over = {}) => Task.create({ organization: orgA._id, project: pOrg._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', dueDate: todayDue, description: 'SECRET-DESCRIPTION', labels: ['SECRET-LABEL'], ...over });
  await mk('member-task');
  await mk('member-private-task', { project: pPriv._id, visibility: 'Private' });
  await mk('admin-private-task', { project: pPriv._id, visibility: 'Private', assignees: [users.admin._id] });
  await mk('admin-public-task', { assignees: [users.admin._id] }); // ordinary read access to a non-private project
  await Meeting.create({ organization: orgA._id, project: pOrg._id, topic: 'Standup', type: 'Scheduled', status: 'Scheduled', startTime: new Date(Date.now() + 3600000), endTime: new Date(Date.now() + 7200000), host: users.owner._id, createdBy: users.owner._id, participants: [{ user: users.member._id }], description: 'SECRET-AGENDA', livekitRoomName: 'SECRET-ROOM' });
});

const names = (body) => body.result.data.map((r) => r.title);

describe('the registered tools, and the callback gate is the only way to run them', () => {
  test('the two Step 3 tools are unchanged and registered together with the five Step 4 tools (plus the Step 5 workload tool: eight in all, all read-only); registering twice changes nothing', () => {
    registerLiveDataTools();
    const defs = registry.listToolDefinitions({ permissions: ['USE_AI'] });
    expect(STEP3_TOOL_NAMES).toEqual(['list_my_tasks', 'list_my_schedule']);
    expect(defs.map((d) => d.name).sort()).toEqual([...LIVE_DATA_TOOL_NAMES].sort());
    expect(defs.map((d) => d.name).sort()).toEqual([...STEP3_TOOL_NAMES, ...STEP4_TOOL_NAMES, 'get_workload_summary'].sort());
    expect(defs).toHaveLength(8);
    for (const name of LIVE_DATA_TOOL_NAMES) expect(registry.findTool(name)).toMatchObject({ kind: 'read', permission: 'USE_AI' });
    expect(registry.findTool('get_workload_summary')).toMatchObject({ kind: 'read', permission: 'USE_AI' }); // Step 5
    expect(registry.findTool('list_my_projects')).toBeNull();
    expect(registry.listToolDefinitions({ permissions: [] })).toEqual([]); // a role without USE_AI is told about no tools
  });

  test('descriptions are written by Node, and argument schemas are strict JSON Schemas (no extra properties)', () => {
    for (const def of registry.listToolDefinitions({ permissions: ['USE_AI'] })) {
      expect(def.description.length).toBeGreaterThan(40);
      expect(def.parameters.additionalProperties).toBe(false);
      // (get_workload_summary legitimately has the enum VALUE "organization"; its only parameter KEY is `scope`)
      if (def.name === 'get_workload_summary') expect(Object.keys(def.parameters.properties)).toEqual(['scope']);
      else expect(JSON.stringify(def)).not.toMatch(/\$ne|\$where|organization|userId/);
    }
  });

  test('requiring the registry alone still yields an empty one (registration is explicit)', () => {
    jest.isolateModules(() => {
      const fresh = require('../../src/services/ai/aiToolRegistry');
      expect(fresh.findTool('list_my_tasks')).toBeNull();
    });
  });

  test('only the callback gate RUNS a tool; the registration module merely checks for duplicates; the public API has no execution route', async () => {
    const root = path.resolve(__dirname, '../../src');
    const lookups = [];
    const runners = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); return; }
      if (!e.name.endsWith('.js')) return;
      const text = fs.readFileSync(full, 'utf8');
      const rel = path.relative(root, full);
      if (/\bfindTool\(/.test(text)) lookups.push(rel);
      if (/\btool\.run\(/.test(text)) runners.push(rel);
    });
    walk(root);
    expect(runners).toEqual(['services/ai/aiCallbacks.service.js']); // the single place a tool's run() is ever invoked
    expect(lookups.sort()).toEqual(['services/ai/aiCallbacks.service.js', 'services/ai/tools/liveDataTools.js']); // the second only avoids double registration
    const app = createApp();
    for (const url of ['/api/v1/ai/tools/execute', '/internal/ai/tools/execute', '/api/v1/ai/tools']) expect([401, 403, 404]).toContain((await request(app).post(url).send({ name: 'list_my_tasks', arguments: {} })).status);
  });
});

describe('roles', () => {
  test('every role that may use AI gets ONLY its own data; admins get no private-project items and no one else\'s', async () => {
    const expectations = { member: ['member-private-task', 'member-task', 'admin-public-task'].filter((t) => t !== 'admin-public-task'), admin: ['admin-public-task'], coadmin: [], hr: [], manager: [], owner: [] };
    for (const [key, expected] of Object.entries(expectations)) {
      const live = await startInFlight(users[key]);
      const body = (await call(live.token, 'list_my_tasks', {}, `t-${key}`).expect(200)).body;
      expect({ key, titles: names(body).sort() }).toEqual({ key, titles: [...expected].sort() });
      await live.finish();
    }
  });

  test('a project OWNER asking for relation "owner" gets the tasks of projects they own, and an admin who owns nothing gets none', async () => {
    const owner = await startInFlight(users.owner);
    const body = (await call(owner.token, 'list_my_tasks', { relation: 'owner' }).expect(200)).body;
    expect(names(body).sort()).toEqual(['admin-private-task', 'admin-public-task', 'member-private-task', 'member-task']); // owner of both projects: a manager of each
    const admin = await startInFlight(users.admin);
    expect(names((await call(admin.token, 'list_my_tasks', { relation: 'owner' }).expect(200)).body)).toEqual([]);
  });

  test('the schedule: member sees own meeting + task entries; an admin invited to nothing sees nothing of the private project', async () => {
    const member = await startInFlight(users.member);
    const body = (await call(member.token, 'list_my_schedule', { range: 'next_7_days' }).expect(200)).body;
    expect(body.result.data.map((e) => e.title).sort()).toEqual(['Standup', 'member-private-task', 'member-task']);
    const admin = await startInFlight(users.admin);
    expect(names((await call(admin.token, 'list_my_schedule', { range: 'next_7_days' }).expect(200)).body)).toEqual(['admin-public-task']);
  });

  test('guests cannot use either tool; the super-admin cannot even start an AI request or forge a callback', async () => {
    const forGuest = tokens.signCallbackToken({ userId: users.guest._id.toString(), orgId: orgA._id.toString(), requestKey: 'guest-req-0001' });
    for (const name of LIVE_DATA_TOOL_NAMES) expect((await call(forGuest, name)).status).toBeGreaterThanOrEqual(401);
    await expect(streamAiRequest({ actor: users.guest, feature: 'tools', messages: MESSAGES, toolBudget: true }).next()).rejects.toMatchObject({ statusCode: 403 });
    await expect(streamAiRequest({ actor: users.superadmin, feature: 'tools', messages: MESSAGES, toolBudget: true }).next()).rejects.toMatchObject({ statusCode: 403 });
    const forged = tokens.signCallbackToken({ userId: users.superadmin._id.toString(), orgId: orgA._id.toString(), requestKey: 'forged-req-0001' });
    for (const name of LIVE_DATA_TOOL_NAMES) expect((await call(forged, name)).status).toBe(401);
  });
});

describe('switches and account state are re-checked on every call', () => {
  test('AI disabled, live data disabled, user blocked, user deactivated, user moved to another organization: the next call is refused with NO data', async () => {
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
      expect((await call(live.token, 'list_my_tasks', {}, 'before')).status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      await change();
      for (const name of STEP3_TOOL_NAMES) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(live.token, name, name === 'list_my_tasks' ? { due: 'today' } : { range: 'today' }, `after-${name}`);
        expect({ label, name, code: res.body.code }).toEqual({ label, name, code });
        expect(JSON.stringify(res.body)).not.toMatch(/member-task|Standup|Apollo|SECRET/);
      }
      // eslint-disable-next-line no-await-in-loop
      await live.finish();
    }
  });
});

describe('arguments', () => {
  test('malformed and unexpected arguments are refused with field NAMES only (never the values), before anything runs', async () => {
    const live = await startInFlight(users.member);
    const spy = jest.spyOn(Task, 'countDocuments');
    const bad = [
      ['list_my_tasks', { status: 'DROP-TABLE-VALUE' }, ['status']],
      ['list_my_tasks', { limit: 500 }, ['limit']],
      ['list_my_tasks', { limit: '5' }, ['limit']],
      ['list_my_tasks', { project: String(pOrg._id) }, ['']],
      ['list_my_tasks', { filter: { $ne: null } }, ['']],
      ['list_my_tasks', { user: String(users.admin._id) }, ['']],
      ['list_my_tasks', { organization: String(orgB._id) }, ['']],
      ['list_my_schedule', { range: 'last_year' }, ['range']],
      ['list_my_schedule', { types: ['event'] }, ['types.0']],
      ['list_my_schedule', { timezone: 'Pacific/Kiritimati' }, ['']],
      ['list_my_schedule', { from: '2020-01-01', to: '2030-01-01' }, ['']],
    ];
    for (const [name, args, fields] of bad) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(live.token, name, args, `bad-${Math.random()}`);
      expect({ name, status: res.status, code: res.body.code }).toEqual({ name, status: 400, code: 'AI_TOOL_BAD_ARGUMENTS' });
      expect(res.body.details.fields).toEqual(fields);
      expect(JSON.stringify(res.body)).not.toMatch(/DROP-TABLE-VALUE|\$ne|Kiritimati|2020-01-01/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('cross-tenant: there is no id argument to forge, and a user of another organization receives nothing of this one', async () => {
    const live = await startInFlight(users.adminB);
    for (const [name, args] of [['list_my_tasks', { relation: 'owner' }], ['list_my_schedule', { range: 'next_14_days' }]]) {
      const res = await call(live.token, name, args, name).expect(200);
      expect(res.body.result.data).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/Apollo|Standup|member-task|Secret/);
    }
    // a token for a user of org A cannot be pointed at org B's budget/in-flight state
    const mixed = tokens.signCallbackToken({ userId: users.member._id.toString(), orgId: orgB._id.toString(), requestKey: live.requestKey });
    expect((await call(mixed, 'list_my_tasks')).status).toBe(401);
  });
});

describe('limits and budgets', () => {
  test('a repeated identical call is refused (409); a changed argument is a new call', async () => {
    const live = await startInFlight(users.member);
    await call(live.token, 'list_my_tasks', { due: 'today' }, 'a').expect(200);
    const dup = await call(live.token, 'list_my_tasks', { due: 'today' }, 'b');
    expect([dup.status, dup.body.code]).toEqual([409, 'AI_TOOL_DUPLICATE']);
    await call(live.token, 'list_my_tasks', { due: 'overdue' }, 'c').expect(200);
  });

  test('the call budget is shared across both tools: the third call of two is refused (429)', async () => {
    env.AI_TOOL_MAX_CALLS = 2;
    const live = await startInFlight(users.member);
    await call(live.token, 'list_my_tasks', {}, 'a').expect(200);
    await call(live.token, 'list_my_schedule', { range: 'today' }, 'b').expect(200);
    const third = await call(live.token, 'list_my_schedule', { range: 'this_week' }, 'c');
    expect([third.status, third.body.code]).toEqual([429, 'AI_TOOL_BUDGET']);
  });

  test('a request with no tool budget cannot run either tool', async () => {
    stub.enqueue({ frames: [{ type: 'text', text: 'hello' }], hangAfterFrames: true });
    const controller = new AbortController();
    const run = (async () => { try { for await (const e of streamAiRequest({ actor: users.member, feature: 'tools', messages: MESSAGES, signal: controller.signal })) void e; } catch { /* aborted */ } })();
    runs.push({ controller, run });
    await until(() => stub.requests.length === 1);
    const token = tokens.signCallbackToken({ userId: users.member._id.toString(), orgId: orgA._id.toString(), requestKey: stub.requests[0].claims.jti });
    for (const name of STEP3_TOOL_NAMES) expect((await call(token, name)).body.code).toBe('AI_TOOL_NOT_FOUND');
  });

  test('an oversized list is trimmed to the byte budget instead of failing: whole rows, flagged, accepted by the validator', async () => {
    await Task.insertMany(Array.from({ length: 20 }, (_, i) => ({ organization: orgA._id, project: pOrg._id, title: `${i}-${'T'.repeat(150)}`, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], dueDate: todayDue })));
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_my_tasks', { limit: 20 }).expect(200);
    expect(res.body.result.summary).toMatchObject({ truncated: true });
    expect(res.body.result.summary.total).toBeGreaterThan(res.body.result.summary.count);
    expect(Buffer.byteLength(JSON.stringify(res.body.result))).toBeLessThanOrEqual(env.AI_TOOL_MAX_RESULT_BYTES);
  });

  test('a tool that would return a field outside its allowlist is refused by the gate (the validator is still in force)', async () => {
    const tool = registry.findTool('list_my_tasks');
    const original = tool.run;
    // the registry freezes its definitions: replace the tool with one that leaks a field, via a fresh registration
    registry.clearTools();
    registry.registerTool({ ...tool, run: async (ctx) => { const out = await original(ctx); out.data[0].description = 'SECRET-DESCRIPTION'; return out; } });
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_my_tasks', { due: 'today' });
    expect([res.status, res.body.code]).toEqual([502, 'AI_TOOL_RESULT_INVALID']);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('output never carries sensitive fields', () => {
  test('descriptions, labels, agendas, room names, emails and internal ids never appear in any result', async () => {
    const live = await startInFlight(users.member);
    const a = (await call(live.token, 'list_my_tasks', {}, 'a').expect(200)).body;
    const b = (await call(live.token, 'list_my_schedule', { range: 'next_14_days' }, 'b').expect(200)).body;
    for (const body of [a, b]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/SECRET|livekit|@|description|labels|checklist|attachments|passwordHash|"_id"/i);
    }
  });
});

describe('audit', () => {
  test('every call is audited with the tool, status, counts and enum arguments only: no titles, project names, people or questions', async () => {
    const live = await startInFlight(users.member);
    await call(live.token, 'list_my_tasks', { status: 'open', due: 'today', relation: 'assigned', limit: 5 }, 'ok-1').expect(200);
    await call(live.token, 'list_my_schedule', { range: 'this_week', types: ['meeting', 'task'] }, 'ok-2').expect(200);
    await call(live.token, 'list_my_tasks', { status: 'nonsense' }, 'bad-1');
    const rows = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.metadata.tool, r.metadata.status, r.metadata.errorCode])).toEqual([
      ['list_my_tasks', 'success', null], ['list_my_schedule', 'success', null], ['list_my_tasks', 'refused', 'AI_TOOL_BAD_ARGUMENTS'],
    ]);
    expect(rows[0].metadata).toMatchObject({ args: { status: 'open', due: 'today', relation: 'assigned', limit: 5 }, argKeys: ['status', 'due', 'relation', 'limit'], requestKey: live.requestKey });
    expect(rows[0].metadata.records).toBeGreaterThanOrEqual(1);
    expect(rows[1].metadata.args).toEqual({ range: 'this_week' }); // the `types` array is reduced to its key name
    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/member-task|Standup|Apollo|Skunkworks Private|Member Tester|SECRET|nonsense/);
  });

  test('usage records the number of tool calls and their time, nothing else', async () => {
    const live = await startInFlight(users.member);
    await call(live.token, 'list_my_tasks', {}, 'a').expect(200);
    await call(live.token, 'list_my_schedule', { range: 'today' }, 'b').expect(200);
    await live.finish();
    await until(async () => (await AiUsageEvent.countDocuments({ requestKey: live.requestKey })) === 1);
    expect(await AiUsageEvent.findOne({ requestKey: live.requestKey }).lean()).toMatchObject({ toolCalls: 2, toolFailures: 0 });
  });
});

describe('cancellation and deadlines reach the queries', () => {
  test('when the REQUEST ends while a tool is running, the tool stops before its next database query', async () => {
    const realScope = aiScope.resolveAiScope;
    let released;
    const gate = new Promise((resolve) => { released = resolve; });
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...args) => { await gate; return realScope(...args); });
    const taskQueries = jest.spyOn(Task, 'countDocuments');
    const live = await startInFlight(users.member);
    const pending = callNow(live.token, 'list_my_tasks');
    await until(() => aiScope.resolveAiScope.mock.calls.length === 1);
    await live.finish(); // the user pressed Stop: the pipeline aborts every running tool of the request
    released();
    const res = await pending;
    expect(res.body.code).toBe('AI_TOOL_ABORTED');
    expect(taskQueries).not.toHaveBeenCalled();
  });

  test('when the caller disconnects, the tool stops before its next query', async () => {
    const realScope = aiScope.resolveAiScope;
    let released;
    const gate = new Promise((resolve) => { released = resolve; });
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...args) => { await gate; return realScope(...args); });
    const queries = jest.spyOn(Task, 'countDocuments');
    const live = await startInFlight(users.member);
    const req = post(live.token, { callId: 'c', name: 'list_my_tasks', arguments: {} });
    req.then(() => {}, () => {});
    await until(() => aiScope.resolveAiScope.mock.calls.length === 1);
    req.abort();
    await new Promise((r) => setTimeout(r, 150));
    released();
    await new Promise((r) => setTimeout(r, 200));
    expect(queries).not.toHaveBeenCalled();
  });

  test('the per-call deadline cuts a slow tool off with the fixed timeout error, and no further query runs', async () => {
    env.AI_TOOL_TIMEOUT_MS = 100;
    const realScope = aiScope.resolveAiScope;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...args) => { await new Promise((r) => setTimeout(r, 400)); return realScope(...args); });
    const queries = jest.spyOn(Task, 'countDocuments');
    const live = await startInFlight(users.member);
    const res = await call(live.token, 'list_my_schedule', { range: 'today' });
    expect([res.status, res.body.code]).toEqual([504, 'AI_TOOL_TIMEOUT']);
    await new Promise((r) => setTimeout(r, 450));
    expect(queries).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/member-task|Standup/);
  });
});
