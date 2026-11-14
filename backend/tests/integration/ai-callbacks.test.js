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
 * Node's independent authorization of every tool callback (CONTRACT §8). Python's tool list is never
 * an authorization boundary: everything here is decided by Node from the token, live state and Node's registry.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { z } = require('zod');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { PERMISSIONS: P } = require('../../src/constants/permissions');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const { clearTools, registerTool } = require('../../src/services/ai/aiToolRegistry');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const internal = createInternalApp();
const redis = () => createRedisClient();
const oid = () => new mongoose.Types.ObjectId();
const MESSAGES = [{ role: 'user', content: 'hi' }];
const saved = {};
let orgA; let orgB;
let runs = [];

const call = (token, body = { callId: 'c1', name: 'whoami', arguments: {} }) => {
  const req = request(internal).post('/internal/ai/tools/execute').send(body);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not reached in time');
};

/** Starts a REAL streaming request that stays in flight; resolves with its callback token and a finish() handle. */
async function startInFlight(actor) {
  stub.enqueue({ frames: [{ type: 'text', text: 'hello' }], hangAfterFrames: true });
  const before = stub.requests.length;
  const controller = new AbortController();
  const run = (async () => {
    try {
      for await (const e of streamAiRequest({ actor, feature: 'chat', messages: MESSAGES, toolBudget: true, signal: controller.signal })) void e;
    } catch {
      /* the abort at the end is expected */
    }
  })();
  runs.push({ controller, run });
  await until(() => stub.requests.length === before + 1);
  const { claims } = stub.requests[before];
  // Python is not issued a callback token yet, so mint one the way Node will in Phase 8.
  return {
    token: tokens.signCallbackToken({ userId: actor._id.toString(), orgId: actor.organization.toString(), requestKey: claims.jti }),
    requestKey: claims.jti,
    finish: async () => {
      controller.abort();
      await run;
    },
  };
}

async function clearRedis() {
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await stub.start();
  for (const k of ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER']) saved[k] = env[k];
  aiService.resetEngine();
});
afterAll(async () => {
  Object.assign(env, saved);
  clearTools();
  await stub.stop();
  await hub.shutdown();
  await clearRedis();
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  runs = [];
  stub.reset();
  aiService.resetEngine();
  env.AI_SERVICE_URL = stub.url;
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  env.AI_GLOBAL_ENABLED = true;
  clearTools();
  const obj = (shape) => z.object(shape).strict();
  registerTool({ name: 'whoami', kind: 'read', permission: P.USE_AI, schema: z.object({ verbose: z.boolean().optional() }).strict(), resultSchema: obj({ user: z.string(), org: z.string(), input: z.object({ verbose: z.boolean().optional() }) }), run: async ({ actor, input }) => ({ user: actor._id.toString(), org: actor.organization.toString(), input }) });
  registerTool({ name: 'admin_only', kind: 'read', permission: P.MANAGE_AI, schema: z.object({}).strict(), resultSchema: obj({ note: z.string() }), run: async () => ({ note: 'ADMIN-DATA' }) });
  registerTool({ name: 'boom', kind: 'read', permission: P.USE_AI, schema: z.object({}).strict(), resultSchema: obj({}), run: async () => { throw new Error('DB password is hunter2'); } });
  registerTool({ name: 'huge', kind: 'read', permission: P.USE_AI, schema: z.object({}).strict(), resultSchema: obj({ blob: z.string() }), run: async () => ({ blob: 'x'.repeat(300 * 1024) }) });
  await clearRedis();
  await Promise.all([AiOrgSettings.deleteMany({}), AiUsageEvent.deleteMany({}), Organization.deleteMany({}), User.deleteMany({})]);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true, liveDataEnabled: true }, { organization: orgB._id, enabled: true, liveDataEnabled: true }]);
});
afterEach(async () => {
  for (const { controller, run } of runs) {
    controller.abort();
    // eslint-disable-next-line no-await-in-loop
    await run;
  }
});

describe('token and request lifetime', () => {
  test('no token, garbage, or the wrong kind of token => the same generic 401', async () => {
    const live = await startInFlight(users.emp);
    const generate = stub.requests[0].headers.authorization.split(' ')[1];
    for (const t of [null, 'garbage', generate, tokens.signStatusToken()]) {
      const res = await call(t);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AI_CALLBACK_UNAUTHORIZED');
    }
    await live.finish();
  });

  test('a valid token works while its request is in flight, and is DEAD the moment the request ends', async () => {
    const live = await startInFlight(users.emp);
    const ok = await call(live.token, { callId: 'c1', name: 'whoami', arguments: { verbose: true } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ success: true, callId: 'c1', result: { user: users.emp._id.toString(), org: orgA._id.toString(), input: { verbose: true } } });
    await live.finish();
    await until(async () => (await AiUsageEvent.countDocuments()) === 1);
    const after = await call(live.token);
    expect(after.status).toBe(401); // the token itself has not expired; the request has
  });

  test('a token whose request was never admitted (forged in-flight claim) is refused', async () => {
    const t = tokens.signCallbackToken({ userId: users.emp._id.toString(), orgId: orgA._id.toString(), requestKey: crypto.randomUUID() });
    expect((await call(t)).status).toBe(401);
  });

  test('a token cannot be moved to another organization: in-flight is keyed by user AND org', async () => {
    const live = await startInFlight(users.emp);
    const moved = tokens.signCallbackToken({ userId: users.emp._id.toString(), orgId: orgB._id.toString(), requestKey: live.requestKey });
    expect((await call(moved)).status).toBe(401);
    const swapped = tokens.signCallbackToken({ userId: users.empB._id.toString(), orgId: orgB._id.toString(), requestKey: live.requestKey });
    expect((await call(swapped)).status).toBe(401);
    await live.finish();
  });

  test('a token without the tool scope is forbidden', async () => {
    const live = await startInFlight(users.emp);
    const t = tokens.signCallbackToken({ userId: users.emp._id.toString(), orgId: orgA._id.toString(), requestKey: live.requestKey, scopes: ['knowledge:read'] });
    expect((await call(t)).status).toBe(403);
    await live.finish();
  });
});

describe('live state is re-checked on every callback (Python cannot make it stale)', () => {
  test('blocking the user mid-request revokes the callback immediately', async () => {
    const live = await startInFlight(users.emp);
    expect((await call(live.token)).status).toBe(200);
    await User.updateOne({ _id: users.emp._id }, { orgBlocked: true });
    expect((await call(live.token)).status).toBe(401);
    await live.finish();
  });

  test('deactivating the user, or removing them from the org, revokes it', async () => {
    const live = await startInFlight(users.emp);
    await User.updateOne({ _id: users.emp._id }, { isActive: false });
    expect((await call(live.token)).status).toBe(401);
    await User.updateOne({ _id: users.emp._id }, { isActive: true, organization: orgB._id });
    expect((await call(live.token)).status).toBe(401);
    await live.finish();
  });

  test('switching AI off for the org, or the platform kill switch, revokes it', async () => {
    const live = await startInFlight(users.emp);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    const res = await call(live.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AI_DISABLED');
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: true });
    expect((await call(live.token)).status).toBe(200);
    env.AI_GLOBAL_ENABLED = false;
    expect((await call(live.token)).status).toBe(403);
    env.AI_GLOBAL_ENABLED = true;
    await live.finish();
  });

  test('a role change takes effect on the next callback', async () => {
    const live = await startInFlight(users.emp);
    expect((await call(live.token, { callId: 'c', name: 'whoami', arguments: {} })).status).toBe(200);
    await User.updateOne({ _id: users.emp._id }, { role: ROLES.GUEST });
    expect((await call(live.token)).status).toBe(403);
    await live.finish();
  });
});

describe('the tool list Python holds is never an authorization boundary', () => {
  test('a tool the user may not use is indistinguishable from a tool that does not exist', async () => {
    const live = await startInFlight(users.emp);
    const forbidden = await call(live.token, { callId: 'c', name: 'admin_only', arguments: {} });
    const missing = await call(live.token, { callId: 'c', name: 'does_not_exist', arguments: {} });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(forbidden.body.code).toBe('AI_TOOL_NOT_FOUND');
    expect({ ...forbidden.body, stack: undefined }).toEqual({ ...missing.body, stack: undefined });
    expect(JSON.stringify(forbidden.body)).not.toContain('ADMIN-DATA');
    await live.finish();
  });

  test('even if Python was TOLD the tool (it was in the request) Node still checks the user\'s permission', async () => {
    stub.enqueue({ frames: [{ type: 'text', text: 'hi' }], hangAfterFrames: true });
    const controller = new AbortController();
    const run = (async () => {
      try {
        for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MESSAGES, toolBudget: true, tools: [{ name: 'admin_only', parameters: { type: 'object', properties: {} } }], signal: controller.signal })) void e;
      } catch { /* aborted */ }
    })();
    runs.push({ controller, run });
    await until(() => stub.requests.length === 1);
    expect(stub.requests[0].body.tools[0].name).toBe('admin_only');
    const res = await call(tokens.signCallbackToken({ userId: users.emp._id.toString(), orgId: orgA._id.toString(), requestKey: stub.requests[0].claims.jti }), { callId: 'c', name: 'admin_only', arguments: {} });
    expect(res.status).toBe(404);
  });

  test('an org admin can use the admin tool: the decision follows the user, not the tool list', async () => {
    const live = await startInFlight(users.admin);
    const res = await call(live.token, { callId: 'c', name: 'admin_only', arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body.result.note).toBe('ADMIN-DATA');
    await live.finish();
  });

  test('identity in the body is rejected and never trusted', async () => {
    const live = await startInFlight(users.emp);
    for (const extra of [{ user: users.admin._id.toString() }, { organization: orgB._id.toString() }, { role: 'org-admin' }]) {
      expect((await call(live.token, { callId: 'c', name: 'whoami', arguments: {}, ...extra })).status).toBe(400);
    }
    const res = await call(live.token, { callId: 'c', name: 'whoami', arguments: { user: 'someone-else' } });
    expect(res.status).toBe(400); // tool schema is strict too
    await live.finish();
  });

  test('bad arguments report field names only, never the values the model produced', async () => {
    const live = await startInFlight(users.emp);
    const res = await call(live.token, { callId: 'c', name: 'whoami', arguments: { verbose: 'PROMPT-INJECTED-VALUE' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AI_TOOL_BAD_ARGUMENTS');
    expect(res.body.details).toEqual({ fields: ['verbose'] });
    expect(JSON.stringify(res.body)).not.toContain('PROMPT-INJECTED-VALUE');
    await live.finish();
  });

  test('a failing tool returns a generic error without leaking internals', async () => {
    const live = await startInFlight(users.emp);
    const res = await call(live.token, { callId: 'c', name: 'boom', arguments: {} });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    await live.finish();
  });

  test('oversized tool results are refused', async () => {
    const live = await startInFlight(users.emp);
    const res = await call(live.token, { callId: 'c', name: 'huge', arguments: {} });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_TOOL_RESULT_TOO_LARGE');
    await live.finish();
  });

  test('only read tools can be registered; write-capable tools cannot be executed through this gate', () => {
    expect(() => registerTool({ name: 'delete_all', kind: 'write', permission: P.USE_AI, schema: z.object({}), resultSchema: z.object({}), run: async () => ({}) })).toThrow();
    expect(() => registerTool({ name: 'bad name!', kind: 'read', permission: P.USE_AI, schema: z.object({}), resultSchema: z.object({}), run: async () => ({}) })).toThrow();
  });

  test('a tool without an explicit result allowlist cannot be registered', () => {
    expect(() => registerTool({ name: 'no_allowlist', kind: 'read', permission: P.USE_AI, schema: z.object({}), run: async () => ({}) })).toThrow();
  });

  test('the production registry ships empty', () => {
    jest.isolateModules(() => {
      const fresh = require('../../src/services/ai/aiToolRegistry');
      expect(fresh.findTool('whoami')).toBeNull();
    });
  });
});

test('the internal app exposes nothing but the callback route', async () => {
  for (const [method, url] of [['get', '/health'], ['get', '/api/v1/ai/status'], ['get', '/internal/ai/tools/execute'], ['post', '/internal/ai/other']]) {
    expect((await request(internal)[method](url)).status).toBe(404);
  }
});
