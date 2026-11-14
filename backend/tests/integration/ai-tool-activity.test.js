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
 * Phase 8 Step 7A: the `tool_activity` event, Python -> Node client -> browser.  Contract: exactly {type, tool}, `tool` one of the eight
 * names. Progress only; it counts as transport activity (first-frame + idle timers) but never moves the absolute request deadline, and it is
 * never model output or usage.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { AI_ERROR_CODES: C, AI_LIVE_TOOL_NAMES } = require('../../src/constants/ai.constants');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const client = require('../../src/services/ai/aiService/client');
const registry = require('../../src/services/ai/aiToolRegistry');
const { make } = require('../../src/services/ai/aiService/errors');
const { LIVE_DATA_TOOL_NAMES, registerLiveDataTools } = require('../../src/services/ai/tools/liveDataTools');
const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');

const { users, createUser, makeAgent, as } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const E5 = describeSpace('multilingual-e5-small');
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const MSGS = [{ role: 'user', content: 'hello' }];
const IDENT = () => ({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: `req-${Math.random().toString(36).slice(2)}-${Date.now()}` });
const SAVE = ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_SERVICE_CONNECT_TIMEOUT_MS', 'AI_SERVICE_FIRST_FRAME_TIMEOUT_MS', 'AI_SERVICE_IDLE_TIMEOUT_MS', 'AI_REQUEST_CEILING_MS', 'AI_RATE_LIMIT_PER_MINUTE', 'AI_MAX_CONCURRENT_PER_USER', 'AI_MAX_OUTPUT_TOKENS'];
const saved = {};

const activity = (tool, extra = {}) => ({ type: 'tool_activity', tool, ...extra });
const text = (t) => ({ type: 'text', text: t });
const usage = { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false };
const done = { type: 'done', finishReason: 'stop', model: 'm', provider: 'groq', requestId: 'r', firstEventMs: 1 };

async function run(params = {}) {
  const events = [];
  const startedAt = Date.now();
  try {
    for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100, ...params })) events.push(e);
  } catch (error) {
    return { error, events, ms: Date.now() - startedAt };
  }
  return { events, ms: Date.now() - startedAt };
}
const sseEvents = (res) => parseSse(res.body);
const parseSse = (raw) => raw.trim().split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('data: ')[1]));
const sse = (r) => r.buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => cb(null, t)); });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await stub.start();
  await Promise.all(['emp'].map(makeAgent));
  for (const k of SAVE) saved[k] = env[k];
  Object.assign(env, { AI_SERVICE_URL: stub.url, AI_SERVICE_SIGNING_KEY: pair.privateKey, AI_SERVICE_KEY_ID: 'v1' });
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
  stub.reset();
  Object.assign(env, { AI_SERVICE_CONNECT_TIMEOUT_MS: 2000, AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 2000, AI_SERVICE_IDLE_TIMEOUT_MS: 2000, AI_REQUEST_CEILING_MS: 10000 });
});

describe('the Node client accepts exactly the contract', () => {
  test.each(AI_LIVE_TOOL_NAMES)('%s is a valid tool_activity and arrives as exactly {type, tool}', async (name) => {
    stub.enqueue({ frames: [activity(name), text('ok'), usage, done] });
    const { events, error } = await run();
    expect(error).toBeUndefined();
    expect(events[0]).toEqual({ type: 'tool_activity', tool: name });
    expect(events.map((e) => e.type)).toEqual(['tool_activity', 'text', 'usage', 'done']);
  });

  test('the allowed names are exactly the eight registered tools', () => {
    registry.clearTools();
    registerLiveDataTools();
    expect([...AI_LIVE_TOOL_NAMES].sort()).toEqual([...LIVE_DATA_TOOL_NAMES].sort());
    expect(registry.listToolDefinitions({ permissions: ['USE_AI'] }).map((d) => d.name).sort()).toEqual([...AI_LIVE_TOOL_NAMES].sort());
    expect(AI_LIVE_TOOL_NAMES).toHaveLength(8);
  });

  test.each([
    ['an unknown tool name', { type: 'tool_activity', tool: 'delete_everything' }],
    ['a name that only looks like a tool', { type: 'tool_activity', tool: 'list_projects ' }],
    ['a different case', { type: 'tool_activity', tool: 'LIST_PROJECTS' }],
    ['no tool field', { type: 'tool_activity' }],
    ['tool: null', { type: 'tool_activity', tool: null }],
    ['tool: a number', { type: 'tool_activity', tool: 5 }],
    ['tool: an object', { type: 'tool_activity', tool: { name: 'list_projects' } }],
    ['tool: an array', { type: 'tool_activity', tool: ['list_projects'] }],
    ['an extra field (arguments)', { type: 'tool_activity', tool: 'list_projects', arguments: { project: 'SECRET' } }],
    ['an extra field (id)', { type: 'tool_activity', tool: 'list_projects', id: 'call_1' }],
    ['an extra field (result)', { type: 'tool_activity', tool: 'list_projects', result: { a: 1 } }],
    ['an empty tool name', { type: 'tool_activity', tool: '' }],
  ])('%s is a PROTOCOL error: the stream fails, nothing is forwarded', async (_label, frame) => {
    stub.enqueue({ frames: [frame, text('MUST-NOT-APPEAR'), usage, done] });
    const { error, events } = await run();
    expect(error).toMatchObject({ code: C.SERVICE_PROTOCOL, streamStarted: false });
    expect(events).toEqual([]);
    expect(JSON.stringify(error)).not.toMatch(/SECRET|delete_everything/);
  });

  test('an activity event is not output: streamStarted stays false if the stream then fails', async () => {
    stub.enqueue({ frames: [activity('list_projects'), { type: 'error', code: C.UNAVAILABLE, retryable: false, streamStarted: false, upstreamStatus: null }] });
    const { error, events } = await run();
    expect(events).toEqual([{ type: 'tool_activity', tool: 'list_projects' }]);
    expect(error).toMatchObject({ streamStarted: false });
  });

  test('the existing frame types are unchanged (a plain stream still works, an unknown type is still a protocol error)', async () => {
    stub.enqueue({ frames: [text('a'), usage, done] });
    expect((await run()).events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    stub.enqueue({ frames: [{ type: 'tool_progress', tool: 'list_projects' }, done] });
    expect((await run()).error.code).toBe(C.SERVICE_PROTOCOL);
  });
});

describe('timers: activity is transport activity, the absolute deadline never moves', () => {
  test('a tool_activity satisfies the FIRST-FRAME timeout and each later one resets the IDLE timeout', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 400, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    // first frame at ~250 ms (< 400), then frames every ~200 ms (< 300 idle) for a total of ~1.1 s: longer than either timer alone
    stub.enqueue({ firstFrameDelayMs: 250, gapMs: 200, frames: [activity('list_projects'), activity('get_team'), activity('list_my_tasks'), activity('get_workload_summary'), text('ok'), usage, done] });
    const { error, events, ms } = await run();
    expect(error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['tool_activity', 'tool_activity', 'tool_activity', 'tool_activity', 'text', 'usage', 'done']);
    expect(ms).toBeGreaterThan(900);
  });

  test('control: the same silence WITHOUT activity frames still times out (first frame)', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 300, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ firstFrameDelayMs: 700, frames: [text('late'), usage, done] });
    expect((await run()).error.code).toBe(C.SERVICE_TIMEOUT);
  });

  test('control: silence AFTER an activity frame still times out (idle)', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 1000, AI_SERVICE_IDLE_TIMEOUT_MS: 300, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ frames: [activity('list_projects')], hangAfterFrames: true });
    const { error, events } = await run();
    expect(error.code).toBe(C.SERVICE_TIMEOUT);
    expect(events).toEqual([{ type: 'tool_activity', tool: 'list_projects' }]);
  });

  test('a steady stream of valid activity can NEVER extend the absolute request deadline', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 5000, AI_SERVICE_IDLE_TIMEOUT_MS: 5000, AI_REQUEST_CEILING_MS: 700 });
    stub.enqueue({ gapMs: 80, frames: Array.from({ length: 60 }, () => activity('list_projects')), hangAfterFrames: true }); // would run ~4.8 s
    const { error, events, ms } = await run();
    expect(error.code).toBe(C.SERVICE_TIMEOUT);
    expect(ms).toBeLessThan(1500); // ended at ~the 700 ms ceiling, not when the activity stopped
    expect(events.length).toBeGreaterThan(2);
    expect(events.length).toBeLessThan(15);
  });

  test('malformed or unknown frames never reset a timer: they end the stream at once', async () => {
    Object.assign(env, { AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: 5000, AI_SERVICE_IDLE_TIMEOUT_MS: 5000, AI_REQUEST_CEILING_MS: 5000 });
    stub.enqueue({ frames: [activity('list_projects'), activity('nope')], hangAfterFrames: true });
    const { error, events, ms } = await run();
    expect(error.code).toBe(C.SERVICE_PROTOCOL);
    expect(events).toEqual([{ type: 'tool_activity', tool: 'list_projects' }]);
    expect(ms).toBeLessThan(1000);
  });

  test('cancelling while only activity has arrived aborts the connection and starts nothing else', async () => {
    stub.enqueue({ frames: [activity('list_projects')], hangAfterFrames: true });
    const controller = new AbortController();
    const seen = [];
    const pending = (async () => {
      try {
        for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100, signal: controller.signal })) { seen.push(e); controller.abort(); }
      } catch (error) {
        return error;
      }
      return null;
    })();
    const error = await pending;
    expect(error.code).toBe(C.ABORTED);
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.state.disconnects).toBeGreaterThanOrEqual(1); // (>=: a previous test's hung connection may close late)
    expect(seen).toEqual([{ type: 'tool_activity', tool: 'list_projects' }]);
  });
});

describe('what the browser receives', () => {
  let org;
  const events = [];
  const engine = {
    name: 'scripted',
    async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory' }; },
    async* chat() { for (const e of events) yield e; },
  };

  beforeEach(async () => {
    events.length = 0;
    aiService.setEngine(engine);
    Object.assign(env, { AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100 });
    const keys = await redis().keys('test:ai:*');
    if (keys.length) await redis().del(keys);
    await Promise.all([AiEmbeddingConfig, AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
    org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
    await createUser(org, 'emp', ROLES.EMPLOYEE);
    await AiOrgSettings.create({ organization: org._id, enabled: true });
    await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
  });

  test('the SSE stream carries tool_activity as EXACTLY two fields, in order, ahead of the answer', async () => {
    events.push(activity('list_projects'), activity('get_workload_summary'), text('You have 3.'), usage, { type: 'citations', citations: [], unverifiedMarkers: [], consideredSources: 0, uncited: true }, done);
    const res = await sse(as('emp').post('/api/v1/ai/ask').set('Accept', 'text/event-stream').send({ question: 'How many projects?' }));
    const got = sseEvents(res);
    expect(got.map((e) => e.type)).toEqual(['tool_activity', 'tool_activity', 'text', 'usage', 'citations', 'done']);
    expect(got[0]).toEqual({ type: 'tool_activity', tool: 'list_projects' });
    expect(got[1]).toEqual({ type: 'tool_activity', tool: 'get_workload_summary' });
    expect(Object.keys(got[0]).sort()).toEqual(['tool', 'type']);
    expect(res.body).toContain('event: tool_activity\ndata: {"type":"tool_activity","tool":"list_projects"}\n\n');
  });

  test('no Python payload field is ever forwarded, even if one slipped past the client (defence in depth)', async () => {
    events.push(activity('list_projects', { arguments: { project: 'SECRET-ARG' }, id: 'call_SECRET', result: { a: 'SECRET-RESULT' }, token: 'eyJSECRET' }), text('ok'), usage, done);
    const res = await sse(as('emp').post('/api/v1/ai/ask').set('Accept', 'text/event-stream').send({ question: 'q?' }));
    const got = sseEvents(res);
    expect(got[0]).toEqual({ type: 'tool_activity', tool: 'list_projects' });
    expect(res.body).not.toMatch(/SECRET|eyJ|call_/);
  });

  test('an unknown tool name is dropped, not forwarded and not fatal', async () => {
    events.push(activity('delete_everything'), activity({ x: 1 }), activity(undefined), text('ok'), usage, done);
    const res = await sse(as('emp').post('/api/v1/ai/ask').set('Accept', 'text/event-stream').send({ question: 'q?' }));
    expect(sseEvents(res).map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    expect(res.body).not.toContain('delete_everything');
  });

  test('a raw tool_calls event and other internal events are still dropped', async () => {
    events.push({ type: 'tool_calls', calls: [{ id: 'c', name: 'list_projects', arguments: '{"project":"SECRET"}' }] }, { type: 'tool_result', result: 'SECRET' }, text('ok'), usage, done);
    const res = await sse(as('emp').post('/api/v1/ai/ask').set('Accept', 'text/event-stream').send({ question: 'q?' }));
    expect(sseEvents(res).map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    expect(res.body).not.toMatch(/SECRET|tool_calls|tool_result/);
  });

  test('plain streams (no activity) are byte-for-byte what they were: text, usage, done', async () => {
    events.push(text('hello'), usage, done);
    const res = await sse(as('emp').post('/api/v1/ai/ask').set('Accept', 'text/event-stream').send({ question: 'q?' }));
    expect(sseEvents(res).map((e) => e.type)).toEqual(['text', 'usage', 'done']);
  });
});

describe('activity is not output and not usage', () => {
  let org;
  beforeEach(async () => {
    Object.assign(env, { AI_GLOBAL_ENABLED: true, AI_RATE_LIMIT_PER_MINUTE: 1000, AI_MAX_CONCURRENT_PER_USER: 50, AI_MAX_OUTPUT_TOKENS: 100 });
    const keys = await redis().keys('test:ai:*');
    if (keys.length) await redis().del(keys);
    await Promise.all([AiOrgSettings, AiUsageEvent, Organization, User].map((m) => m.deleteMany({})));
    org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
    await createUser(org, 'emp', ROLES.EMPLOYEE);
    await AiOrgSettings.create({ organization: org._id, enabled: true });
  });
  const lastEvent = async () => (await AiUsageEvent.find({}).sort({ createdAt: -1 }).limit(1).lean())[0];

  test('a request cancelled after only activity events was never "started": charged 0, exactly like before', async () => {
    const controller = new AbortController();
    aiService.setEngine({
      name: 's',
      async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory' }; },
      async* chat(params) {
        yield activity('list_projects');
        yield activity('get_team');
        await new Promise((resolve) => params.signal.addEventListener('abort', resolve, { once: true }));
        throw make(C.ABORTED);
      },
    });
    const got = [];
    const pending = (async () => {
      try { for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MSGS, signal: controller.signal })) got.push(e); } catch (error) { return error; }
      return null;
    })();
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    expect((await pending).code).toBe(C.ABORTED);
    expect(got.map((e) => e.type)).toEqual(['tool_activity', 'tool_activity']);
    expect(await lastEvent()).toMatchObject({ status: 'cancelled', chargedTokens: 0, streamStarted: false, outputTokens: 0 });
  });

  test('on success the charge is exactly the reported usage; activity adds nothing to it', async () => {
    aiService.setEngine({
      name: 's',
      async status() { return { reachable: true, configured: true, provider: 'groq', models: { chat: 'm', summarize: 'm' }, version: 't', replayStore: 'memory' }; },
      async* chat() { yield activity('list_projects'); yield activity('get_team'); yield text('answer'); yield { ...usage, inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }; yield done; },
    });
    for await (const e of streamAiRequest({ actor: users.emp, feature: 'chat', messages: MSGS })) void e;
    expect(await lastEvent()).toMatchObject({ status: 'success', inputTokens: 1000, outputTokens: 50, chargedTokens: 1050, streamStarted: true });
  });
});
