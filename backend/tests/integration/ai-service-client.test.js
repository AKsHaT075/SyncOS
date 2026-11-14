/**
 * The real Node client (fetch + SSE parsing + timers + abort) against a real HTTP server that speaks the
 * Python service's wire contract. No Python, no Groq, no key. Also reads the shared contract fixtures.
 */
const fs = require('fs');
const path = require('path');
const env = require('../../src/config/env');
const { AI_ERROR_CODES: C } = require('../../src/constants/ai.constants');
const client = require('../../src/services/ai/aiService/client');
const { fromHttpResponse } = require('../../src/services/ai/aiService/errors');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');

const contract = (name) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../ai/contracts', name), 'utf8'));
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const saved = {};
const IDENT = () => ({ userId: 'a'.repeat(24), orgId: 'b'.repeat(24), requestKey: `req-${Math.random().toString(36).slice(2)}-${Date.now()}` });
const MSGS = [{ role: 'user', content: 'PROMPT-SECRET hello' }];

beforeAll(async () => {
  await stub.start();
  for (const k of ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_SERVICE_KEY_ID', 'AI_SERVICE_CONNECT_TIMEOUT_MS', 'AI_SERVICE_FIRST_FRAME_TIMEOUT_MS', 'AI_SERVICE_IDLE_TIMEOUT_MS', 'AI_REQUEST_CEILING_MS']) saved[k] = env[k];
  env.AI_SERVICE_URL = stub.url;
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_SERVICE_KEY_ID = 'v1';
});
afterAll(async () => {
  Object.assign(env, saved);
  await stub.stop();
});
beforeEach(() => {
  stub.reset();
  env.AI_SERVICE_CONNECT_TIMEOUT_MS = 2000;
  env.AI_SERVICE_FIRST_FRAME_TIMEOUT_MS = 2000;
  env.AI_SERVICE_IDLE_TIMEOUT_MS = 2000;
  env.AI_REQUEST_CEILING_MS = 10000;
});

async function collect(params = {}) {
  const events = [];
  for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100, ...params })) events.push(e);
  return events;
}
const failure = async (params) => {
  const events = [];
  try {
    for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 100, ...params })) events.push(e);
  } catch (error) {
    return { error, events };
  }
  throw new Error('expected a failure');
};
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
};

describe('request', () => {
  test('sends a signed, single-use, identity-free-body request', async () => {
    const identity = IDENT();
    await collect({ identity, tools: [{ name: 't', parameters: {} }], toolChoice: 'auto', temperature: 0.5 });
    const [req] = stub.requests;
    expect(req.claims).toMatchObject({ sub: identity.userId, org: identity.orgId, jti: identity.requestKey, mo: 100, aud: 'syncos-ai:generate' });
    expect(req.body).toEqual({ purpose: 'chat', messages: MSGS, tools: [{ name: 't', parameters: {} }], toolChoice: 'auto', temperature: 0.5 });
    for (const forbidden of ['user', 'userId', 'organization', 'orgId', 'role', 'permissions']) expect(req.body).not.toHaveProperty(forbidden);
    expect(req.headers['x-syncos-callback-token']).toBeUndefined(); // no callback token until tools exist (Phase 8)
  });

  test('omits optional fields rather than sending nulls', async () => {
    await collect();
    expect(stub.requests[0].body).toEqual({ purpose: 'chat', messages: MSGS });
  });
});

describe('streaming', () => {
  test('yields the pipeline event contract', async () => {
    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'done']);
    expect(events[2]).toMatchObject({ finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'req_stub' });
  });

  test.each(contract('frames.json').cases.filter((c) => c.events.at(-1).type === 'done').map((c) => [c.name, c]))('shared wire fixture: %s', async (_name, fixture) => {
    stub.enqueue({ raw: fixture.wire });
    const events = await collect();
    expect(events.length).toBe(fixture.events.length);
    expect(events.map((e) => e.type)).toEqual(fixture.events.map((e) => e.type));
    for (const [i, expected] of fixture.events.entries()) {
      if (expected.type === 'text') expect(events[i].text).toBe(expected.text);
      if (expected.type === 'tool_calls') expect(events[i].calls[0]).toMatchObject({ id: expected.calls[0].id, inputError: expected.calls[0].inputError });
    }
  });

  test.each(contract('frames.json').cases.filter((c) => c.events.at(-1).type === 'error').map((c) => [c.name, c]))('shared wire fixture (failure): %s', async (_name, fixture) => {
    stub.enqueue({ raw: fixture.wire });
    const { error, events } = await failure();
    const terminal = fixture.events.at(-1);
    expect(error).toMatchObject({ code: terminal.code, streamStarted: terminal.streamStarted, retryable: false });
    expect(events.length).toBe(fixture.events.length - 1);
  });

  test('keepalive comments are ignored', async () => {
    stub.enqueue({ raw: `: ping\n\n${stub.frame({ type: 'text', text: 'a' })}: ping\n\n${stub.frame(stub.DONE)}` });
    expect((await collect()).map((e) => e.type)).toEqual(['text', 'done']);
  });
});

describe('truncated and malformed streams are failures, never partial successes', () => {
  test.each(contract('truncated.json').truncated.map((c) => [c.name, c]))('%s', async (_name, fixture) => {
    stub.enqueue({ raw: fixture.wire });
    const { error } = await failure();
    expect(error.code).toBe(C.SERVICE_UNAVAILABLE);
    expect(error.streamStarted).toBe(fixture.wire.includes('"type":"text"'));
  });

  test('text then connection cut mid-frame', async () => {
    stub.enqueue({ raw: `${stub.frame({ type: 'text', text: 'half' })}event: text\ndata: {"type":"te` });
    const { error, events } = await failure();
    expect(events).toHaveLength(1);
    expect(error).toMatchObject({ code: C.SERVICE_PROTOCOL, streamStarted: true });
  });

  test.each([
    ['unknown frame type', { type: 'surprise' }],
    ['text without text', { type: 'text' }],
    ['negative usage', { type: 'usage', inputTokens: -1, outputTokens: 1, totalTokens: 0 }],
    ['non-numeric usage', { type: 'usage', inputTokens: '5', outputTokens: 1, totalTokens: 6 }],
    ['tool call without id', { type: 'tool_calls', calls: [{ name: 'x', arguments: '{}' }] }],
    ['done without finishReason', { type: 'done' }],
  ])('protocol violation: %s', async (_n, frame) => {
    stub.enqueue({ raw: stub.frame(frame) });
    expect((await failure()).error.code).toBe(C.SERVICE_PROTOCOL);
  });

  test('an unknown error code from Python never leaks through verbatim', async () => {
    stub.enqueue({ raw: stub.frame({ type: 'error', code: 'SOMETHING_NEW\nPROMPT-SECRET', retryable: true, streamStarted: false }) });
    const { error } = await failure();
    expect(error.code).toBe(C.INVALID_RESPONSE);
    expect(JSON.stringify(error.message) + error.code).not.toContain('PROMPT-SECRET');
  });

  test('frames after the terminal frame are ignored', async () => {
    stub.enqueue({ raw: `${stub.frame(stub.DONE)}${stub.frame({ type: 'text', text: 'late' })}` });
    expect((await collect()).map((e) => e.type)).toEqual(['done']);
  });
});

describe('HTTP-level failures from Python', () => {
  test.each([
    [401, 'TOKEN_INVALID', C.SERVICE_AUTH],
    [409, 'REPLAYED', C.SERVICE_PROTOCOL],
    [422, 'BAD_REQUEST', C.SERVICE_PROTOCOL],
    [413, 'BODY_TOO_LARGE', C.SERVICE_PROTOCOL],
    [503, 'NOT_CONFIGURED', C.NOT_CONFIGURED],
    [503, 'REPLAY_STORE_UNAVAILABLE', C.SERVICE_UNAVAILABLE],
    [500, 'INTERNAL', C.SERVICE_UNAVAILABLE],
  ])('%i %s -> %s', async (status, code, expected) => {
    stub.enqueue({ status, body: { error: { code } } });
    const { error } = await failure();
    expect(error.code).toBe(expected);
    expect(error.streamStarted).toBe(false);
  });

  test('never retries: exactly one generate request per call, even for retryable failures', async () => {
    stub.enqueue({ status: 503, body: { error: { code: 'REPLAY_STORE_UNAVAILABLE' } } });
    await failure();
    expect(stub.requests).toHaveLength(1);
    stub.enqueue({ raw: stub.frame({ type: 'error', code: C.RATE_LIMITED, retryable: true, streamStarted: false, upstreamStatus: 429 }) });
    await failure();
    expect(stub.requests).toHaveLength(2);
  });

  test('unreachable service', async () => {
    const real = env.AI_SERVICE_URL;
    env.AI_SERVICE_URL = 'http://127.0.0.1:1';
    const { error } = await failure();
    env.AI_SERVICE_URL = real;
    expect(error.code).toBe(C.SERVICE_UNAVAILABLE);
  });

  test('without a signing key nothing is sent', async () => {
    const key = env.AI_SERVICE_SIGNING_KEY;
    env.AI_SERVICE_SIGNING_KEY = '';
    const { error } = await failure();
    env.AI_SERVICE_SIGNING_KEY = key;
    expect(error.code).toBe(C.NOT_CONFIGURED);
    expect(stub.requests).toHaveLength(0);
  });

  test('replaying the same request key is refused by the service and surfaces as a protocol error', async () => {
    const identity = IDENT();
    await collect({ identity });
    const { error } = await failure({ identity });
    expect(error.code).toBe(C.SERVICE_PROTOCOL);
  });
});

describe('timeouts', () => {
  test('no response headers in time -> AI_SERVICE_TIMEOUT', async () => {
    env.AI_SERVICE_CONNECT_TIMEOUT_MS = 80;
    stub.enqueue({ delayMs: 1000, frames: [stub.DONE] });
    expect((await failure()).error.code).toBe(C.SERVICE_TIMEOUT);
  });

  test('no first frame in time -> AI_SERVICE_TIMEOUT', async () => {
    env.AI_SERVICE_FIRST_FRAME_TIMEOUT_MS = 80;
    stub.enqueue({ frames: [], hangAfterFrames: true });
    const { error } = await failure();
    expect(error.code).toBe(C.SERVICE_TIMEOUT);
    expect(error.streamStarted).toBe(false);
  });

  test('silence after output -> timeout with streamStarted', async () => {
    env.AI_SERVICE_IDLE_TIMEOUT_MS = 80;
    stub.enqueue({ frames: [{ type: 'text', text: 'one' }], hangAfterFrames: true });
    const { error, events } = await failure();
    expect(events).toHaveLength(1);
    expect(error).toMatchObject({ code: C.SERVICE_TIMEOUT, streamStarted: true });
  });

  test('the request ceiling stops a stream that keeps dripping', async () => {
    env.AI_REQUEST_CEILING_MS = 150;
    const drip = Array.from({ length: 400 }, () => ({ type: 'text', text: '.' }));
    stub.enqueue({ frames: drip, hangAfterFrames: true });
    expect((await failure()).error.code).toBe(C.SERVICE_TIMEOUT);
  });
});

describe('cancellation reaches the service', () => {
  test('aborting mid-stream closes the connection (the service sees a disconnect) and ends as ABORTED', async () => {
    stub.enqueue({ frames: [{ type: 'text', text: 'one' }], hangAfterFrames: true });
    const controller = new AbortController();
    const seen = [];
    const run = (async () => {
      try {
        for await (const e of client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 10, signal: controller.signal })) {
          seen.push(e);
          controller.abort();
        }
      } catch (error) {
        return error;
      }
      return null;
    })();
    const error = await run;
    expect(error).toMatchObject({ code: C.ABORTED, streamStarted: true });
    await until(() => stub.state.disconnects === 1);
  });

  test('an already-aborted signal sends nothing and signs nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const { error } = await failure({ signal: controller.signal });
    expect(error.code).toBe(C.ABORTED);
    expect(stub.requests).toHaveLength(0);
  });

  test('a consumer that simply stops iterating also disconnects', async () => {
    stub.enqueue({ frames: [{ type: 'text', text: 'one' }], hangAfterFrames: true });
    const it = client.chat({ identity: IDENT(), purpose: 'chat', messages: MSGS, maxOutputTokens: 10 });
    await it.next();
    await it.return();
    await until(() => stub.state.disconnects === 1);
  });
});

describe('status', () => {
  test('reports readiness and models, never secrets', async () => {
    const s = await client.status();
    expect(s).toMatchObject({ reachable: true, configured: true, provider: 'groq', models: { chat: 'openai/gpt-oss-120b' } });
    expect(JSON.stringify(s)).not.toMatch(/key|secret|token/i);
  });
  test('unconfigured service', async () => {
    stub.setConfigured(false);
    expect(await client.status()).toMatchObject({ reachable: true, configured: false });
  });
  test('unreachable service and wrong key are both "not configured", never a throw', async () => {
    const real = env.AI_SERVICE_URL;
    env.AI_SERVICE_URL = 'http://127.0.0.1:1';
    expect(await client.status()).toMatchObject({ reachable: false, configured: false });
    env.AI_SERVICE_URL = real;
    const key = env.AI_SERVICE_SIGNING_KEY;
    env.AI_SERVICE_SIGNING_KEY = createKeyPair().privateKey;
    expect(await client.status()).toMatchObject({ reachable: true, configured: false, reason: 'AUTH' });
    env.AI_SERVICE_SIGNING_KEY = key;
  });
});

describe('error mapping parity with Python (shared fixture)', () => {
  test.each(contract('error_mapping.json').cases.map((c) => [`${c.status} -> ${c.code}`, c]))('%s', (_n, c) => {
    const headers = { get: (k) => c.headers[k.toLowerCase()] ?? null };
    const error = fromHttpResponse(c.status, c.body, headers);
    expect(error.code).toBe(c.code);
    expect(error.retryable).toBe(c.retryable);
    expect(error.retryAfterMs).toBe(c.retryAfterMs);
  });
});
