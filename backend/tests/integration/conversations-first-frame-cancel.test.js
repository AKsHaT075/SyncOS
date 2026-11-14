jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingRequestDecisionEmail: jest.fn(), sendMeetingInvitationEmail: jest.fn(),
}));

/**
 * Step 9D: stopping BEFORE the first assistant frame must not silently lose the user's message. The turn is kept, the reply is marked incomplete
 * (cancelled), usage settles exactly once, the conversation is free again, and nothing is duplicated. A REFUSED request (nothing accepted) still
 * rolls back so the draft can be retried.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const { make } = require('../../src/services/ai/aiService/errors');
const { createKeyPair } = require('../helpers/stubAiService');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AIConversation = require('../../src/models/AIConversation');
const AiMessage = require('../../src/models/AiMessage');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');

const { users, createUser, makeAgent, as } = createHarness();
const E5 = describeSpace('multilingual-e5-small');
const pair = createKeyPair();
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('condition not reached in time'); }; // eslint-disable-line no-await-in-loop
let calls; let behaviour;

const engine = {
  name: 'first-frame',
  async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory' }; },
  async* chat(params) {
    calls.push(params);
    if (behaviour === 'hang') {
      await new Promise((resolve) => { if (params.signal?.aborted) resolve(); else params.signal?.addEventListener('abort', resolve, { once: true }); });
      throw make(C.ABORTED);
    }
    if (behaviour === 'snapshot-then-hang') {
      yield { type: 'usage', inputTokens: 1700, outputTokens: 40, totalTokens: 1740, estimated: false };
      await new Promise((resolve) => { if (params.signal?.aborted) resolve(); else params.signal?.addEventListener('abort', resolve, { once: true }); });
      throw make(C.ABORTED);
    }
    yield { type: 'retrieval', candidates: 0, authorized: 0, rejected: 0, belowThreshold: 0, duplicates: 0, used: 0, rounds: 1, topScore: null };
    yield { type: 'text', text: 'A real answer.' };
    yield { type: 'usage', inputTokens: 100, outputTokens: 10, totalTokens: 110, estimated: false };
    yield { type: 'citations', citations: [], unverifiedMarkers: [], consideredSources: 0, uncited: true };
    yield { type: 'done', finishReason: 'stop', model: 'm', provider: 'groq', requestId: 'r', firstEventMs: 1 };
  },
};

const newConv = async () => (await as('emp').post('/api/v1/ai/conversations').send({}).expect(201)).body.conversation.id;
/** Starts a message and returns a handle: the request is destroyed with .stop() (the browser pressing Stop / closing the tab). */
function sendMessage(id, content) {
  const req = as('emp').post(`/api/v1/ai/conversations/${id}/messages`).set('Accept', 'text/event-stream').send({ content }).buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });
  const done = new Promise((resolve) => req.then((res) => resolve({ status: res.status, body: res.body }), (error) => resolve({ error })));
  return { stop: () => req.abort(), done };
}
const rows = (id) => AiMessage.find({ conversation: id }).sort({ seq: 1 }).lean();

beforeAll(async () => { await connectTestDb(); await connectRedis(); await makeAgent('emp'); });
afterAll(async () => { aiService.resetEngine(); await hub.shutdown(); const k = await redis().keys('test:ai*'); if (k.length) await redis().del(k); await disconnectTestDb(); await redis().quit(); });
beforeEach(async () => {
  calls = []; behaviour = 'answer';
  Object.assign(env, { AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100 });
  const keys = await redis().keys('test:ai:*'); if (keys.length) await redis().del(keys);
  await Promise.all([AiEmbeddingConfig, AIConversation, AiMessage, AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
  const org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await AiOrgSettings.create({ organization: org._id, enabled: true });
  await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
  aiService.setEngine(engine);
});

test('Stop BEFORE the first assistant frame keeps the user message and an incomplete (cancelled) reply; usage settles once; the conversation is free', async () => {
  behaviour = 'hang';
  const id = await newConv();
  const msg = sendMessage(id, 'My important question');
  await until(() => calls.length === 1);
  msg.stop();
  await msg.done;
  await until(async () => (await AiUsageEvent.countDocuments({ status: 'cancelled' })) === 1);
  await until(async () => !(await AIConversation.findById(id).lean()).activeRequestKey);
  const saved = await rows(id);
  expect(saved.map((r) => [r.role, r.status])).toEqual([['user', 'complete'], ['assistant', 'incomplete']]);
  expect(saved[0].content).toBe('My important question'); // the user's words are NOT lost
  expect(saved[1]).toMatchObject({ content: '', finishReason: 'cancelled', errorCode: 'AI_REQUEST_ABORTED' });
  expect(await AIConversation.findById(id)).toMatchObject({ activeRequestKey: null, leaseExpiresAt: null, messageCount: 2 });
  expect(await AiUsageEvent.countDocuments()).toBe(1);
  expect(await redis().keys('test:ai:q:*:r:*')).toEqual([]);
});

test('...and nothing is duplicated: sending again works, adds exactly one new exchange, and the cancelled exchange is not offered as history', async () => {
  behaviour = 'hang';
  const id = await newConv();
  const first = sendMessage(id, 'First');
  await until(() => calls.length === 1);
  first.stop(); await first.done;
  await until(async () => !(await AIConversation.findById(id).lean()).activeRequestKey);
  behaviour = 'answer';
  const second = await sendMessage(id, 'Second').done;
  expect(second.status).toBe(200);
  const saved = await rows(id);
  expect(saved.map((r) => [r.role, r.content || '', r.status])).toEqual([['user', 'First', 'complete'], ['assistant', '', 'incomplete'], ['user', 'Second', 'complete'], ['assistant', 'A real answer.', 'complete']]);
  expect(calls[1].rag.history || []).toEqual([]); // the cancelled turn is not context for the next question
  expect(await AiUsageEvent.countDocuments()).toBe(2); // one per request: never two for the same one
});

test('a duplicate send while the first is still in flight is refused (409); after Stop there is exactly ONE user message', async () => {
  behaviour = 'hang';
  const id = await newConv();
  const first = sendMessage(id, 'Same question');
  await until(() => calls.length === 1);
  const second = await sendMessage(id, 'Same question').done;
  expect(second.status).toBe(409);
  first.stop(); await first.done;
  await until(async () => !(await AIConversation.findById(id).lean()).activeRequestKey);
  expect(await AiMessage.countDocuments({ conversation: id, role: 'user' })).toBe(1);
  expect(await AiMessage.countDocuments({ conversation: id, role: 'assistant' })).toBe(1);
  expect(calls).toHaveLength(1);
});

test('the latest usage snapshot is settled even though no assistant frame ever arrived', async () => {
  behaviour = 'snapshot-then-hang';
  const id = await newConv();
  const msg = sendMessage(id, 'Question');
  await until(() => calls.length === 1);
  await sleep(150);
  msg.stop(); await msg.done;
  await until(async () => (await AiUsageEvent.countDocuments({ status: 'cancelled' })) === 1);
  expect(await AiUsageEvent.findOne({}).lean()).toMatchObject({ status: 'cancelled', streamStarted: false });
  await until(async () => !(await AIConversation.findById(id).lean()).activeRequestKey);
  expect((await rows(id)).map((r) => r.status)).toEqual(['complete', 'incomplete']);
});

test('a REFUSED request (nothing accepted: quota) still rolls back, so the draft can simply be retried', async () => {
  await AiOrgSettings.updateOne({}, { quotas: { userDailyTokens: 50 } });
  const id = await newConv();
  const r = await sendMessage(id, 'Will be refused').done;
  expect([413, 429]).toContain(r.status);
  expect(await rows(id)).toEqual([]);
  expect(await AIConversation.findById(id)).toMatchObject({ activeRequestKey: null, messageCount: 0 });
  expect(calls).toHaveLength(0);
});

test('a normal completed turn is unchanged', async () => {
  const id = await newConv();
  const r = await sendMessage(id, 'Hello').done;
  expect(r.status).toBe(200);
  expect((await rows(id)).map((x) => [x.role, x.status])).toEqual([['user', 'complete'], ['assistant', 'complete']]);
  expect(await AiUsageEvent.countDocuments()).toBe(1);
});
