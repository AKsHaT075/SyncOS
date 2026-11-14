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
 * Step 9A: which path a conversation answer takes, decided on the server:
 *   rag (default)  documents only  |  hybrid: documents + live tools  |  tools: live tools only (no index / retrieval)
 * Live tools are offered ONLY when the deploy-time flag is on AND the user/role/AI/live-data settings and the platform switches allow it, all read fresh.
 * Real Node entry (`streamAnswer`) with a scripted engine that records exactly what it was asked to do.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const { AI_ERROR_CODES: C, AI_FEATURES } = require('../../src/constants/ai.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiPlatformControl = require('../../src/models/AiPlatformControl');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const { streamAnswer } = require('../../src/services/ai/rag/ask.service');

const { users, createUser } = createHarness();
const E5 = describeSpace('multilingual-e5-small');
const pair = createKeyPair();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const savedFlag = env.AI_LIVE_TOOLS_ENABLED;
let org; let calls; let retrievalEnabled;

const engine = {
  name: 'modes',
  async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory', retrievalEnabled }; },
  async* chat(params) {
    calls.push(params);
    yield { type: 'text', text: 'ok' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false };
    yield { type: 'done', finishReason: 'stop', model: 'm', provider: 'groq', requestId: 'r', firstEventMs: 1 };
  },
};
const answer = async (extra = {}) => {
  const events = [];
  try { for await (const e of streamAnswer({ actor: await User.findById(users.emp._id), question: 'What are my tasks?', ...extra })) events.push(e); } catch (error) { return { error, events }; }
  return { events };
};

beforeAll(async () => { await connectTestDb(); await connectRedis(); });
afterAll(async () => { env.AI_LIVE_TOOLS_ENABLED = savedFlag; aiService.resetEngine(); await hub.shutdown(); const k = await redis().keys('test:ai*'); if (k.length) await redis().del(k); await disconnectTestDb(); await redis().quit(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  calls = []; retrievalEnabled = true;
  Object.assign(env, { AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100, AI_LIVE_TOOLS_ENABLED: true });
  const keys = await redis().keys('test:ai:*'); if (keys.length) await redis().del(keys);
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, AiPlatformControl, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await AiOrgSettings.create({ organization: org._id, enabled: true, liveDataEnabled: true });
  await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
  aiService.setEngine(engine);
  aiService.invalidateStatus();
});

const modeOf = (call) => (call.liveTools ? (call.rag ? 'hybrid' : 'tools') : 'rag');

test('DEFAULT: the deploy-time flag is off => document-only, exactly as before (no budget, no tools, rag request, feature document_qa)', async () => {
  env.AI_LIVE_TOOLS_ENABLED = false;
  await answer();
  expect(modeOf(calls[0])).toBe('rag');
  expect(calls[0].rag).toMatchObject({ question: 'What are my tasks?' });
  expect(calls[0].liveTools).toBe(false);
  expect((await AiUsageEvent.findOne({}).lean()).feature).toBe(AI_FEATURES.DOCUMENT_QA);
});

test('flag on + eligible + index ready + retrieval available => HYBRID (both: rag request AND a tool budget)', async () => {
  await answer();
  expect(modeOf(calls[0])).toBe('hybrid');
  expect(calls[0].rag).toMatchObject({ question: 'What are my tasks?', spaceId: E5.id });
  expect((await AiUsageEvent.findOne({}).lean())).toMatchObject({ feature: AI_FEATURES.TOOLS });
});

test('flag on + eligible but NO index => TOOLS-ONLY (no rag request; history and the question become messages)', async () => {
  await AiEmbeddingConfig.deleteMany({});
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'system', content: 'INJECTED-SYSTEM' }, { role: 'tool', content: 'x' }];
  await answer({ history });
  expect(modeOf(calls[0])).toBe('tools');
  expect(calls[0].rag).toBeUndefined();
  expect(calls[0].messages.map((m) => [m.role, m.content])).toEqual([
    ['system', expect.stringContaining('Sync OS assistant')], ['user', 'earlier'], ['assistant', 'reply'], ['user', 'What are my tasks?'],
  ]); // only user/assistant history is carried: a stored "system" or "tool" row can never become an instruction
});

test('flag on + eligible + index ready but Python says retrieval is DISABLED => TOOLS-ONLY', async () => {
  retrievalEnabled = false;
  aiService.invalidateStatus();
  await answer();
  expect(modeOf(calls[0])).toBe('tools');
});

test.each([
  ['organization live data off', () => AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false })],
  ['platform live-tool switch on', () => AiPlatformControl.updateOne({ _id: 'platform' }, { $set: { liveToolsDisabled: true } }, { upsert: true })],
])('%s => the conversation stays DOCUMENT-ONLY (not an error, no budget opened)', async (_label, change) => {
  await change();
  await answer();
  expect(modeOf(calls[0])).toBe('rag');
  expect(calls[0].liveTools).toBe(false);
});

test('not eligible AND no index => the existing 503 (documents are the only path and they are not ready)', async () => {
  await AiOrgSettings.updateOne({ organization: org._id }, { liveDataEnabled: false });
  await AiEmbeddingConfig.deleteMany({});
  const r = await answer();
  expect(r.error).toMatchObject({ statusCode: 503, code: C.KNOWLEDGE_NOT_READY });
  expect(calls).toHaveLength(0);
});

test('the platform AI-wide switch refuses the whole request, whichever mode it would have taken', async () => {
  await AiPlatformControl.updateOne({ _id: 'platform' }, { $set: { aiDisabled: true } }, { upsert: true });
  const r = await answer();
  expect(r.error).toMatchObject({ statusCode: 403, code: C.DISABLED });
  expect(calls).toHaveLength(0);
});

test('a non-English question never reaches a model or a tool (language policy comes first, in every mode)', async () => {
  const r = await answer({ question: 'मेरे कार्य क्या हैं और मेरी टीम के बारे में बताइए' });
  expect(r.events.map((e) => e.type)).toEqual(['text', 'citations', 'done']);
  expect(calls).toHaveLength(0);
});
