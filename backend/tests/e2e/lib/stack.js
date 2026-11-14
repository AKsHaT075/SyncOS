/**
 * The isolated end-to-end stack used by the Step 8 jest suites: REAL Node app (supertest), REAL internal callback listener, REAL Python (uvicorn),
 * a scripted fake Groq, an isolated MongoDB database (per jest file) and the `test:` Redis prefixes. Throw-away data only.
 * (Live tools are switched on here by tests/e2e/lib/activation.js via jest.mock in each suite: never by production code.)
 */
const mongoose = require('mongoose');
const env = require('../../../src/config/env');
const { createKeyPair } = require('../../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../../src/config/redis');
const aiService = require('../../../src/services/ai/aiService');
const registry = require('../../../src/services/ai/aiToolRegistry');
const { registerLiveDataTools } = require('../../../src/services/ai/tools/liveDataTools');
const { createInternalApp } = require('../../../src/internalApp');
const { enableLiveToolsForIsolatedTest } = require('./activation');
const { createFakeGroq } = require('./fakeGroq');
const { HAVE_PYTHON, freePort, startPython } = require('./pythonService');
const { seedFixtures } = require('./fixtures');

const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_MAX_OUTPUT_TOKENS', 'AI_GLOBAL_ENABLED', 'AI_TOOL_TIMEOUT_MS', 'AI_TOOL_TOTAL_MS', 'AI_TOOL_MAX_CALLS', 'AI_TOOL_MAX_CONCURRENT', 'AI_REQUEST_CEILING_MS', 'AI_SERVICE_IDLE_TIMEOUT_MS', 'AI_SERVICE_FIRST_FRAME_TIMEOUT_MS'];
const parseSse = (raw) => (raw || '').trim().split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('data: ')[1]));
const collect = (res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); };
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

function createStack(harness, { pythonEnv = {} } = {}) {
  const { users, createUser, as, makeAgent } = harness;
  const S = { groq: createFakeGroq(), pair: createKeyPair(), internal: null, py: null, F: null, saved: {}, until, HAVE_PYTHON };
  const redis = () => createRedisClient();
  S.redis = redis;

  S.start = async () => {
    for (const k of SAVE) S.saved[k] = env[k];
    S.restoreFlag = enableLiveToolsForIsolatedTest(env); // the REAL AI_LIVE_TOOLS_ENABLED flag, this process only (refuses outside an isolated database)
    await S.groq.listen();
    const internalPort = await freePort();
    S.internal = createInternalApp().listen(internalPort, '127.0.0.1');
    S.pyOptions = { publicKey: S.pair.publicKey, internalPort, groqBaseUrl: `http://127.0.0.1:${S.groq.port}/openai/v1`, extraEnv: { AI_FIRST_BYTE_TIMEOUT_MS: '2500', AI_STREAM_IDLE_TIMEOUT_MS: '2500', ...pythonEnv } };
    S.py = await startPython({ port: await freePort(), ...S.pyOptions });
    S.internalPort = internalPort;
    Object.assign(env, { AI_SERVICE_URL: S.py.url, AI_SERVICE_SIGNING_KEY: S.pair.privateKey, AI_SERVICE_KEY_ID: 'v1', AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_GLOBAL_ENABLED: true, AI_MAX_OUTPUT_TOKENS: 300, AI_TOOL_TIMEOUT_MS: 8000, AI_TOOL_TOTAL_MS: 20000, AI_TOOL_MAX_CALLS: 5, AI_TOOL_MAX_CONCURRENT: 2, AI_REQUEST_CEILING_MS: 120000 });
    aiService.resetEngine();
  };

  S.stop = async () => {
    S.restoreFlag?.();
    Object.assign(env, S.saved);
    S.py?.kill();
    if (S.internal) await new Promise((r) => S.internal.close(r));
    await S.groq.close();
    registry.clearTools();
    aiService.resetEngine();
    const keys = await redis().keys('test:ai*');
    if (keys.length) await redis().del(keys);
  };

  /** A clean slate for ONE test: empty collections, empty Redis prefix, fresh fixtures, agents for everyone. */
  S.reset = async () => {
    S.groq.reset();
    registry.clearTools();
    registerLiveDataTools();
    const keys = await redis().keys('test:ai:*');
    if (keys.length) await redis().del(keys);
    await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
    for (const k of Object.keys(users)) delete users[k];
    S.F = await seedFixtures({ makeUser: createUser });
    for (const k of Object.keys(users)) await makeAgent(k); // eslint-disable-line no-await-in-loop
    Object.assign(env, { AI_TOOL_TIMEOUT_MS: 8000, AI_TOOL_TOTAL_MS: 20000, AI_TOOL_MAX_CALLS: 5, AI_TOOL_MAX_CONCURRENT: 2, AI_REQUEST_CEILING_MS: 120000, AI_SERVICE_IDLE_TIMEOUT_MS: 35000, AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 30000 });
    return S.F;
  };

  /** Starts a fresh Python process (after a test killed the old one) and points Node at it. */
  S.restartPython = async () => {
    S.py?.kill();
    S.py = await startPython({ port: await freePort(), ...S.pyOptions });
    env.AI_SERVICE_URL = S.py.url;
    aiService.invalidateStatus();
  };

  S.createConversation = async (key) => (await as(key).post('/api/v1/ai/conversations').send({}).expect(201)).body.conversation;

  /** Sends one message over the REAL SSE endpoint. Returns { done, abort, req }; `done` resolves { status, events, body }. */
  S.startChat = (key, content, { conversationId } = {}) => {
    const out = { events: [], aborted: false };
    out.done = (async () => {
      const id = conversationId || (await S.createConversation(key)).id;
      out.conversationId = id;
      const req = as(key).post(`/api/v1/ai/conversations/${id}/messages`).set('Accept', 'text/event-stream').send({ content }).buffer(true).parse(collect);
      out.req = req;
      return new Promise((resolve) => {
        req.then((res) => resolve({ status: res.status, events: res.status === 200 ? parseSse(res.body) : [], body: res.body, conversationId: id }), (error) => resolve({ error, status: 0, events: [], conversationId: id }));
      });
    })();
    out.abort = () => out.req?.abort();
    return out;
  };
  S.chat = (key, content, opts) => S.startChat(key, content, opts).done;

  /** Tool results as the MODEL saw them, from Groq's request number `index` (default: the last one). */
  S.toolResults = (index = S.groq.requests.length - 1) => S.groq.toolMessages(index);
  S.allGroqText = () => JSON.stringify(S.groq.requests);
  return S;
}

module.exports = { createStack, parseSse, until, HAVE_PYTHON };
