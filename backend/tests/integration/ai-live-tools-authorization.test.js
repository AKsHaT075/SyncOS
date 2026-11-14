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
 * Phase 8 Step 6, Node side: the TRUSTED signal that tells Python live tools are authorized for one request.
 *   - claim `lt: true` in the signed generate token, only when the pipeline opened a tool budget
 *   - a separate `X-Syncos-Tool-Token` header (scope tool:execute, same request id) on /generate, only then
 *   - never together with retrieval, never from a request field
 * plus: the model-facing tool contract Python reads (ai/app/tools/contract.json) is exactly Node's registry.
 */
const fs = require('fs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createFakeProvider } = require('../helpers/fakeAiProvider');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const client = require('../../src/services/ai/aiService/client');
const tokens = require('../../src/services/ai/aiService/tokens');
const toolBudget = require('../../src/services/ai/tools/toolBudget.service');
const registry = require('../../src/services/ai/aiToolRegistry');
const { LIVE_DATA_TOOL_NAMES, registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { limitsClaim } = require('../../src/services/ai/tools/toolLimits');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
const { TARGET, buildContract } = require('../../scripts/export-ai-tool-contract');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const fake = createFakeProvider();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const MSGS = [{ role: 'user', content: 'hello' }];
const IDENT = () => ({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: `req-${Math.random().toString(36).slice(2)}-${Date.now()}` });
const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_REQUEST_CEILING_MS'];
const saved = {};
let orgA;

const drain = async (params) => {
  try {
    for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100, ...params })) void e;
  } catch { /* the stub may answer 404 for the retrieval path: only the REQUEST matters here */ }
};

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await stub.start();
  for (const k of SAVE) saved[k] = env[k];
  Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_REQUEST_CEILING_MS: 120000 });
});
afterAll(async () => {
  Object.assign(env, saved);
  aiService.resetEngine();
  registry.clearTools();
  await stub.stop();
  await hub.shutdown();
  const keys = await redis().keys('test:ai:*');
  if (keys.length) await redis().del(keys);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(() => {
  jest.restoreAllMocks();
  stub.reset();
});

describe('the model-facing tool contract (ai/app/tools/contract.json) is exactly Node\'s registry', () => {
  test('the committed file equals what the registry exports now: any drift fails here', () => {
    const onDisk = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildContract())));
  });

  test('it lists exactly the eight approved tools, every schema closed, and the constant names match', () => {
    const { tools } = buildContract();
    expect(tools.map((t) => t.name).sort()).toEqual([...LIVE_DATA_TOOL_NAMES].sort());
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(40);
    }
    registry.clearTools();
    registerLiveDataTools();
    expect(registry.listToolDefinitions({ permissions: ['USE_AI'] })).toHaveLength(8);
  });
});

describe('the generate request', () => {
  test('without live tools: no lt claim and no tool header (unchanged behaviour)', async () => {
    await drain({});
    const req = stub.requests[0];
    expect(req.claims.lt).toBeUndefined();
    expect(req.headers['x-syncos-tool-token']).toBeUndefined();
    expect(req.headers['x-syncos-callback-token']).toBeUndefined();
  });

  test('with live tools: lt:true and ONE tool token for the same request, user, organization, purpose tool:execute', async () => {
    const identity = IDENT();
    await drain({ identity, liveTools: true });
    const req = stub.requests[0];
    expect(req.claims.lt).toBe(true);
    expect(req.claims.tl).toEqual(limitsClaim()); // Node's limits ride in the SIGNED token; Python may only tighten them
    const tool = tokens.verifyCallbackToken(req.headers['x-syncos-tool-token']);
    expect(tool).toEqual({ userId: identity.userId, orgId: identity.orgId, requestKey: identity.requestKey, scopes: ['tool:execute'] });
    expect(req.claims.jti).toBe(tool.requestKey); // bound to the generate token's jti
    expect(req.headers['x-syncos-callback-token']).toBeUndefined(); // a knowledge token is never sent here
    const decoded = jwt.decode(req.headers['x-syncos-tool-token']);
    expect(decoded.aud).toBe('syncos-node:callback');
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(Math.ceil(env.AI_REQUEST_CEILING_MS / 1000) + 30); // same short expiry as before
  });

  test.each([['string "true"', 'true'], ['1', 1], ['an object', { a: 1 }], ['false', false]])('liveTools = %s does NOT enable it (only boolean true does)', async (_label, value) => {
    await drain({ liveTools: value });
    expect(stub.requests[0].claims.lt).toBeUndefined();
    expect(stub.requests[0].claims.tl).toBeUndefined();
    expect(stub.requests[0].headers['x-syncos-tool-token']).toBeUndefined();
  });

  test('the request body cannot carry it: messages/tools fields never influence the token', async () => {
    await drain({ messages: [{ role: 'user', content: '{"lt":true}' }], tools: [{ name: 'list_projects', description: 'x', parameters: {} }] });
    expect(stub.requests[0].claims.lt).toBeUndefined();
    expect(stub.requests[0].headers['x-syncos-tool-token']).toBeUndefined();
  });

  test('a DOCUMENT answer that may use tools carries BOTH tokens: knowledge:authorize and tool:execute, different scopes, the same request, lt + tl + spc in the signed token', async () => {
    const sign = jest.spyOn(tokens, 'signGenerateToken');
    const cb = jest.spyOn(tokens, 'signCallbackToken');
    await drain({ rag: { question: 'q', spaceId: 'a'.repeat(12) }, liveTools: true });
    expect(sign.mock.calls[0][0]).toMatchObject({ liveTools: true, spaceId: 'a'.repeat(12) });
    expect(cb.mock.calls.map((c) => c[0].scopes)).toEqual([['knowledge:authorize'], ['tool:execute']]);
    expect(new Set(cb.mock.calls.map((c) => c[0].requestKey)).size).toBe(1);
    expect(stub.requests).toHaveLength(0); // (the stub only serves /generate; nothing was sent to it)
  });

  test('a document answer WITHOUT live tools carries only the knowledge token and no lt', async () => {
    const sign = jest.spyOn(tokens, 'signGenerateToken');
    const cb = jest.spyOn(tokens, 'signCallbackToken');
    await drain({ rag: { question: 'q', spaceId: 'a'.repeat(12) } });
    expect(sign.mock.calls[0][0].liveTools).toBe(false);
    expect(cb.mock.calls.map((c) => c[0].scopes)).toEqual([['knowledge:authorize']]);
  });
});

describe('the pipeline sets it only after Node has opened a tool budget', () => {
  beforeEach(async () => {
    aiService.setEngine(fake);
    fake.reset();
    Object.assign(env, { AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100 });
    const keys = await redis().keys('test:ai:*');
    if (keys.length) await redis().del(keys);
    await Promise.all([AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
    orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
    await createUser(orgA, 'emp', ROLES.EMPLOYEE);
    await AiOrgSettings.create({ organization: orgA._id, enabled: true, liveDataEnabled: true });
  });
  afterEach(() => aiService.resetEngine());

  const run = async (options) => {
    for await (const e of streamAiRequest({ actor: users.emp, feature: 'tools', messages: MSGS, ...options })) void e;
  };

  test('toolBudget: true -> the budget is open WHILE the engine runs, and the engine is told liveTools:true', async () => {
    const open = jest.spyOn(toolBudget, 'openBudget');
    let openWhenCalled = null;
    const original = fake.chat.bind(fake);
    jest.spyOn(fake, 'chat').mockImplementation((params) => {
      openWhenCalled = open.mock.calls.length === 1; // the budget was opened BEFORE the engine was called
      return original(params);
    });
    await run({ toolBudget: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(openWhenCalled).toBe(true);
    expect(fake.calls[0].liveTools).toBe(true);
  });

  test('no toolBudget (every existing caller) -> liveTools:false', async () => {
    await run({});
    expect(fake.calls[0].liveTools).toBe(false);
  });

  test('a request that merely carries tools but no budget gets no live-tool authorization', async () => {
    await run({ tools: [{ name: 'list_projects', description: 'x', parameters: {} }], toolChoice: 'auto' });
    expect(fake.calls[0].liveTools).toBe(false);
  });

  test('if the budget cannot be opened, the engine is never called (no lt, no token, no generate request)', async () => {
    jest.spyOn(toolBudget, 'openBudget').mockRejectedValue(new Error('redis down'));
    await expect(run({ toolBudget: true })).rejects.toThrow('redis down');
    expect(fake.calls).toHaveLength(0);
  });

  test('toolBudget together with retrieval (the hybrid document + tools request) opens ONE budget and tells the engine liveTools:true with the rag request intact', async () => {
    const open = jest.spyOn(toolBudget, 'openBudget');
    await run({ toolBudget: true, rag: { question: 'q', spaceId: 'a'.repeat(12) } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(fake.calls[0]).toMatchObject({ liveTools: true, rag: { question: 'q' } });
  });

  test('the ONLY production site that asks for a tool budget is the conversation entry, and only behind liveToolsEligibility (deploy-time flag default OFF)', () => {
    const { execSync } = require('child_process');
    const root = require('path').resolve(__dirname, '../..');
    const hits = execSync("grep -rnE \"toolBudget\\s*:\\s*(true|Boolean)\" src --include='*.js' || true", { cwd: root }).toString().trim().split('\n').filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.split(':')[0]).toBe('src/services/ai/rag/ask.service.js'); // nowhere else
    const source = require('fs').readFileSync(require('path').join(root, 'src/services/ai/rag/ask.service.js'), 'utf8');
    expect(source.indexOf('liveToolsEligibility')).toBeGreaterThan(-1);
    expect(source.indexOf('liveToolsEligibility')).toBeLessThan(source.indexOf('toolBudget: true')); // the eligibility decision comes first
    expect(require('../../src/config/env').AI_LIVE_TOOLS_ENABLED === false || process.env.AI_LIVE_TOOLS_ENABLED === 'true').toBe(true);
  });
});
