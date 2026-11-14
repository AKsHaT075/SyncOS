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
 * Phase 8 Step 6A, CROSS-PROCESS: the real Node pipeline + the real Node internal callback listener + the REAL Python service
 * (uvicorn) + a local fake Groq. Isolated: its own test database and Redis prefix, a throw-away organization and users, no production
 * data, no real Groq key. The only "caller" that turns live tools on is THIS test file (options.toolBudget), so nothing in production is
 * activated. Skipped (loudly) if ai/.venv is missing.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const { AUDIT_EVENTS } = require('../../src/constants/audit.constants');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const AuditLog = require('../../src/models/AuditLog');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const registry = require('../../src/services/ai/aiToolRegistry');
const aiScope = require('../../src/services/ai/tools/aiScope');
const tokens = require('../../src/services/ai/aiService/tokens');
const { registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { createInternalApp } = require('../../src/internalApp');

const AI_DIR = path.resolve(__dirname, '../../../ai');
const PYTHON = path.join(AI_DIR, '.venv/bin/python');
const HAVE_PYTHON = fs.existsSync(PYTHON);
if (!HAVE_PYTHON) console.warn('[ai-live-tools-cross-process] SKIPPED: ai/.venv not found');
const d = HAVE_PYTHON ? describe : describe.skip;

const { users, createUser } = createHarness();
const pair = createKeyPair();
const redis = () => createRedisClient();
const oid = () => new mongoose.Types.ObjectId();
const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_TOOL_TIMEOUT_MS', 'AI_TOOL_TOTAL_MS', 'AI_MAX_OUTPUT_TOKENS'];
const saved = {};
const procs = [];
let groq; let groqPort; let internal; let internalPort; let py; let org; let orgOther;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
};

const groqChunk = (delta, finish = null, extra = {}) => ({ id: 'cmpl-1', model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const USAGE = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
const toolPlan = (...calls) => ({ chunks: [groqChunk({ tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) }), groqChunk({}, 'tool_calls', { usage: USAGE })] });
const textPlan = (text) => ({ chunks: [groqChunk({ content: text }), groqChunk({}, 'stop', { usage: USAGE })] });

function createGroq() {
  const state = { requests: [], plans: [], disconnects: 0 };
  state.server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    state.requests.push(JSON.parse(Buffer.concat(parts).toString() || '{}'));
    res.on('close', () => { if (!res.writableFinished) state.disconnects += 1; });
    const plan = state.plans.shift() || textPlan('default');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of plan.chunks) {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, plan.gapMs || 5));
    }
    if (plan.hang) return undefined;
    res.write('data: [DONE]\n\n');
    return res.end();
  });
  return state;
}

async function startPython(port) {
  const proc = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:build', '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], {
    cwd: AI_DIR,
    env: {
      PATH: process.env.PATH, AI_JWT_PUBLIC_KEY: pair.publicKey, AI_JWT_KEY_ID: 'v1', GROQ_API_KEY: 'gsk_CROSS_PROCESS_FAKE_KEY',
      GROQ_BASE_URL: `http://127.0.0.1:${groqPort}/openai/v1`, AI_REPLAY_STORE: 'redis', REDIS_URL: 'redis://127.0.0.1:6379', AI_REDIS_PREFIX: 'test:ai-service',
      AI_MAX_RETRIES: '0', AI_NODE_INTERNAL_URL: `http://127.0.0.1:${internalPort}`, PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.logs = '';
  proc.stdout.on('data', (b) => { proc.logs += b; });
  proc.stderr.on('data', (b) => { proc.logs += b; });
  procs.push(proc);
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 20000);
  return { port, proc, url: `http://127.0.0.1:${port}` };
}

const MESSAGES = [{ role: 'system', content: 'NODE-SYSTEM' }, { role: 'user', content: 'PROMPT-SECRET what projects do I have?' }];
const ask = async (actor, { controller = new AbortController(), options = {} } = {}) => {
  const events = [];
  try {
    for await (const e of streamAiRequest({ actor, feature: 'tools', messages: MESSAGES, toolBudget: true, signal: controller.signal, ...options })) events.push(e);
  } catch (error) {
    return { error, events };
  }
  return { events };
};
const toolMessages = (requestIndex) => groq.requests[requestIndex].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
const lastUsage = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];

beforeAll(async () => {
  if (!HAVE_PYTHON) return;
  await connectTestDb();
  await connectRedis();
  for (const k of SAVE) saved[k] = env[k];
  groq = createGroq();
  await new Promise((r) => groq.server.listen(0, '127.0.0.1', r));
  groqPort = groq.server.address().port;
  internalPort = await freePort();
  internal = createInternalApp().listen(internalPort, '127.0.0.1');
  py = await startPython(await freePort());
  Object.assign(env, { AI_SERVICE_URL: py.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_GLOBAL_ENABLED: true, AI_MAX_OUTPUT_TOKENS: 200 });
  aiService.resetEngine();
}, 60000);

afterAll(async () => {
  Object.assign(env, saved);
  for (const p of procs) p.kill('SIGTERM');
  if (internal) await new Promise((r) => internal.close(r));
  if (groq) await new Promise((r) => groq.server.close(r));
  registry.clearTools();
  aiService.resetEngine();
  if (HAVE_PYTHON) {
    await hub.shutdown();
    const keys = await redis().keys('test:ai*');
    if (keys.length) await redis().del(keys);
    await disconnectTestDb();
    await redis().quit();
  }
});

beforeEach(async () => {
  if (!HAVE_PYTHON) return;
  jest.restoreAllMocks();
  groq.requests.length = 0; groq.plans.length = 0; groq.disconnects = 0;
  Object.assign(env, { AI_TOOL_TIMEOUT_MS: 8000, AI_TOOL_TOTAL_MS: 20000 });
  registry.clearTools();
  registerLiveDataTools();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await Promise.all([AiOrgSettings, AiUsageEvent, AuditLog, Organization, Project, Task, User].map((m) => m.deleteMany({})));
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgOther = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await createUser(org, 'owner', ROLES.EMPLOYEE);
  await createUser(org, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgOther, 'otherAdmin', ROLES.ORG_ADMIN);
  await AiOrgSettings.create([{ organization: org._id, enabled: true, liveDataEnabled: true }, { organization: orgOther._id, enabled: true, liveDataEnabled: true }]);
  const mk = (over) => Project.create({ organization: org._id, createdBy: users.owner._id, owner: users.owner._id, status: 'Active', ...over });
  await mk({ name: 'Apollo', slug: 'apollo', visibility: 'Organization', members: [{ user: users.emp._id, role: 'Contributor' }] });
  await mk({ name: 'TOP-SECRET-PRIVATE-PROJECT', slug: 'secret', visibility: 'Private' });
  await Project.create({ organization: orgOther._id, createdBy: users.otherAdmin._id, owner: users.otherAdmin._id, name: 'OTHER-ORG-PROJECT', slug: 'o', visibility: 'Organization', status: 'Active' });
});

d('permitted call: real Python -> real Node -> real tool', () => {
  test('list_projects runs for the signed-in user only; the model sees the visible project, never the private/foreign ones; the browser stream is text+usage+done', async () => {
    groq.plans.push(toolPlan({ id: 'call_1', name: 'list_projects', args: { limit: 10 } }), textPlan('You can see Apollo.'));
    const { events, error } = await ask(users.emp);
    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['tool_activity', 'text', 'usage', 'done']);
    expect(events[0]).toEqual({ type: 'tool_activity', tool: 'list_projects' }); // the NAME only: no limit:10, no call id
    const seen = JSON.stringify(groq.requests[1].messages);
    expect(seen).toContain('Apollo');
    expect(seen).not.toMatch(/TOP-SECRET-PRIVATE-PROJECT|OTHER-ORG-PROJECT/);
    const tool = toolMessages(1)[0];
    expect(tool.status).toBe('ok');
    expect(JSON.stringify(events)).not.toMatch(/call_1|tool_calls|Bearer|"limit"|arguments/);
    // Node authorized, ran and audited it; usage covers BOTH model rounds, once
    const audit = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean();
    expect(audit.map((a) => [a.metadata.tool, a.metadata.status])).toEqual([['list_projects', 'success']]);
    expect(await lastUsage()).toMatchObject({ status: 'success', inputTokens: 240, outputTokens: 24, totalTokens: 264, chargedTokens: 264, toolCalls: 1, quotaSettled: true });
    // no callback token ever reached Groq
    expect(JSON.stringify(groq.requests)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  }, 30000);

  test('two model-requested calls in one response both run through Node and are answered under their own ids', async () => {
    groq.plans.push(toolPlan({ id: 'a1', name: 'list_projects' }, { id: 'b2', name: 'get_workload_summary', args: { scope: 'me' } }), textPlan('done'));
    const { error } = await ask(users.emp);
    expect(error).toBeUndefined();
    const msgs = groq.requests[1].messages.filter((m) => m.role === 'tool');
    expect(msgs.map((m) => m.tool_call_id)).toEqual(['a1', 'b2']);
    expect(msgs.every((m) => JSON.parse(m.content).status === 'ok')).toBe(true);
    expect((await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean()).map((a) => a.metadata.tool).sort()).toEqual(['get_workload_summary', 'list_projects']);
  }, 30000);
});

d('denied and refused', () => {
  test('a private project the user cannot see is "not_found" from Node (and Python never invents a tool name)', async () => {
    groq.plans.push(toolPlan({ id: 'c1', name: 'get_project_overview', args: { project: 'TOP-SECRET-PRIVATE-PROJECT' } }, { id: 'c2', name: 'delete_project', args: {} }), textPlan('nothing found'));
    const { events } = await ask(users.admin); // even an org admin: AI has no admin bypass of private projects
    expect(events.filter((e) => e.type === 'tool_activity')).toEqual([{ type: 'tool_activity', tool: 'get_project_overview' }]); // the unknown tool was refused: never announced
    const [overview, unknown] = toolMessages(1);
    expect(overview).toMatchObject({ status: 'ok', result: { outcome: 'not_found' } });
    expect(JSON.stringify(groq.requests[1].messages.filter((m) => m.role === 'tool'))).not.toContain('Apollo');
    expect(unknown).toEqual({ status: 'error', error: 'AI_TOOL_NOT_FOUND' }); // refused by Python; Node was never asked
    expect((await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean()).map((a) => a.metadata.tool)).toEqual(['get_project_overview']);
  }, 30000);

  test('invalid arguments from the model are refused by Python and never reach Node', async () => {
    groq.plans.push(toolPlan({ id: 'c1', name: 'list_projects', args: { organization: String(orgOther._id) } }), textPlan('sorry'));
    await ask(users.emp);
    expect(toolMessages(1)[0]).toEqual({ status: 'error', error: 'AI_TOOL_BAD_ARGUMENTS', invalidFields: [''] });
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
  }, 30000);

  test('another organization\'s user gets only their own data through the same path', async () => {
    groq.plans.push(toolPlan({ id: 'c1', name: 'list_projects' }), textPlan('ok'));
    await ask(users.otherAdmin);
    const seen = JSON.stringify(groq.requests[1].messages);
    expect(seen).toContain('OTHER-ORG-PROJECT');
    expect(seen).not.toMatch(/Apollo|TOP-SECRET/);
  }, 30000);
});

d('authorization failures stop everything', () => {
  test('live data switched OFF while the request is running: Node refuses the callback, Python stops, there is no second model call and no data (and a request cannot even START with it off: the guard refuses before any budget)', async () => {
    const first = toolPlan({ id: 'c1', name: 'list_projects' });
    first.gapMs = 150; // time for the switch to flip between "authorized" and "callback"
    groq.plans.push(first, textPlan('MUST-NOT-APPEAR'));
    const pending = ask(users.emp);
    await until(() => groq.requests.length === 1);
    await AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false });
    const { error, events } = await pending;
    expect(error.code).toBe(C.TOOL_ERROR);
    expect(groq.requests).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('MUST-NOT-APPEAR');
    expect(JSON.stringify(groq.requests)).not.toContain('Apollo');
    expect((await lastUsage()).chargedTokens).toBe(132); // the one round that really happened is charged (Python reported it before the error)
    // and a NEW request for an organization with live data off never opens a budget at all
    groq.requests.length = 0;
    const refused = await ask(users.emp);
    expect(refused.error.code).toBe(C.LIVE_DATA_DISABLED);
    expect(groq.requests).toHaveLength(0);
  }, 30000);

  test('the user is blocked AFTER the request was authorized and BEFORE the tool callback: the callback is refused', async () => {
    const first = toolPlan({ id: 'c1', name: 'list_projects' });
    first.gapMs = 150; // time for the block to land between "authorized" and "callback"
    groq.plans.push(first, textPlan('MUST-NOT-APPEAR'));
    const pending = ask(users.emp);
    await until(() => groq.requests.length === 1);
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: true });
    const { error } = await pending;
    expect(error.code).toBe(C.TOOL_ERROR);
    expect(groq.requests).toHaveLength(1);
    expect(JSON.stringify(groq.requests)).not.toContain('Apollo');
  }, 30000);

  test('role/permission change mid-request: demoting to a role with no AI access is honoured by the callback', async () => {
    const first = toolPlan({ id: 'c1', name: 'list_projects' });
    first.gapMs = 150;
    groq.plans.push(first, textPlan('MUST-NOT-APPEAR'));
    const pending = ask(users.emp);
    await until(() => groq.requests.length === 1);
    await User.updateOne({ _id: users.emp._id }, { role: ROLES.GUEST });
    const { error } = await pending;
    expect(error.code).toBe(C.TOOL_ERROR);
    expect(groq.requests).toHaveLength(1);
  }, 30000);

  test('a missing or invalid tool token at Python: refused before any Groq call (raw request, real signatures)', async () => {
    const identity = { userId: String(users.emp._id), orgId: String(org._id), requestKey: `req-${Date.now()}-aaaa` };
    const call = (headers) => fetch(`${py.url}/internal/v1/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ purpose: 'chat', messages: MESSAGES }) });
    const generate = (key) => tokens.signGenerateToken({ ...identity, requestKey: key, maxOutputTokens: 100, liveTools: true });
    expect((await call({ Authorization: `Bearer ${generate(`${identity.requestKey}-1`)}` })).status).toBe(401); // lt without a tool token
    const knowledge = tokens.signCallbackToken({ ...identity, requestKey: `${identity.requestKey}-2`, scopes: ['knowledge:authorize'] });
    expect((await call({ Authorization: `Bearer ${generate(`${identity.requestKey}-2`)}`, 'X-Syncos-Tool-Token': knowledge })).status).toBe(401); // wrong purpose
    const other = tokens.signCallbackToken({ ...identity, requestKey: 'some-other-request-id', scopes: ['tool:execute'] });
    expect((await call({ Authorization: `Bearer ${generate(`${identity.requestKey}-3`)}`, 'X-Syncos-Tool-Token': other })).status).toBe(401); // another request
    expect(groq.requests).toHaveLength(0);
  }, 30000);
});

d('timeout and cancellation', () => {
  test('a tool that exceeds Node\'s per-call limit comes back as AI_TOOL_TIMEOUT to the model, and the answer still completes', async () => {
    env.AI_TOOL_TIMEOUT_MS = 150;
    const real = aiScope.resolveAiScope;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { await new Promise((r) => setTimeout(r, 600)); return real(...a); });
    groq.plans.push(toolPlan({ id: 'c1', name: 'list_projects' }), textPlan('could not load'));
    const { error } = await ask(users.emp);
    expect(error).toBeUndefined();
    expect(toolMessages(1)[0]).toEqual({ status: 'error', error: 'AI_TOOL_TIMEOUT' });
    expect((await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean())[0].metadata.status).toBe('refused');
  }, 30000);

  test('cancelling while the model is thinking closes the Groq stream, runs no tool, and settles once', async () => {
    const hang = textPlan('partial');
    hang.hang = true;
    groq.plans.push(hang);
    const controller = new AbortController();
    const pending = ask(users.emp, { controller });
    await until(() => groq.requests.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const { error } = await pending;
    expect(error.code).toBe(C.ABORTED);
    await until(() => groq.disconnects >= 1);
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
    expect(await AiUsageEvent.countDocuments()).toBe(1);
    expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]); // reservation settled and removed
  }, 30000);

  test('cancelling while a tool is running aborts it on Node and starts no further model call', async () => {
    const real = aiScope.resolveAiScope;
    let entered = false;
    jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => { entered = true; await new Promise((r) => setTimeout(r, 1500)); return real(...a); });
    groq.plans.push(toolPlan({ id: 'c1', name: 'list_projects' }), textPlan('MUST-NOT-APPEAR'));
    const controller = new AbortController();
    const pending = ask(users.emp, { controller });
    await until(() => entered);
    controller.abort();
    const { error } = await pending;
    expect(error.code).toBe(C.ABORTED);
    await new Promise((r) => setTimeout(r, 300));
    expect(groq.requests).toHaveLength(1);
    const audits = await AuditLog.find({ action: AUDIT_EVENTS.AI_TOOL_INVOKED }).lean();
    expect(audits.length).toBeLessThanOrEqual(1);
    const ev = await lastUsage();
    expect(ev.status).toBe('cancelled');
    expect(ev.chargedTokens).toBeGreaterThanOrEqual(0);
  }, 30000);
});

d('plain generate and sensitive output', () => {
  test('a request without a tool budget behaves as before: no tools offered to Groq, no callback, no tool rules added', async () => {
    groq.plans.push(textPlan('hello'));
    const { events } = await ask(users.emp, { options: { toolBudget: false } });
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'done']); // no tools: no activity either
    expect(groq.requests[0].tools).toBeUndefined();
    expect(groq.requests[0].messages[0].content).toBe('NODE-SYSTEM');
    expect(await AuditLog.countDocuments({ action: AUDIT_EVENTS.AI_TOOL_INVOKED })).toBe(0);
  }, 30000);

  test('Python\'s logs hold no token, prompt, tool argument, or result', async () => {
    groq.plans.push(toolPlan({ id: 'c1', name: 'get_project_overview', args: { project: 'Apollo' } }), textPlan('ok'));
    await ask(users.emp);
    expect(py.proc.logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|PROMPT-SECRET|Apollo|gsk_/);
  }, 30000);
});
