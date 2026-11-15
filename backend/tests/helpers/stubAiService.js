const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');

/**
 * A real HTTP server that speaks the Python AI service's wire contract (docs/ai/ai-service-contract.md):
 * verifies ES256 tokens exactly like Python does, enforces single-use `jti`, streams SSE frames.
 * Used to test the REAL Node client (fetch, SSE parsing, timeouts, abort) without Python or Groq.
 *
 * plan (per generate request, via enqueue(); else defaultPlan):
 *   frames          events to send, each {type,...}
 *   truncate        true  => end the body after `frames` WITHOUT a terminal frame
 *   hangAfterFrames true  => keep the connection open after `frames` (until the client disconnects)
 *   delayMs         wait before responding
 *   status/body     reply with a plain JSON failure instead of a stream
 *   raw             send these exact bytes as the stream body
 */
function createKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
}

const frameText = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const DONE = { type: 'done', finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'req_stub', firstEventMs: 5 };
const OK_PLAN = () => ({
  frames: [
    { type: 'text', text: 'COMPLETION-SECRET answer' },
    { type: 'usage', inputTokens: 20, outputTokens: 10, totalTokens: 30, estimated: false },
    DONE,
  ],
});

function createStubAiService({ publicKey, kid = 'v1' }) {
  const queue = [];
  const seenJti = new Set();
  const requests = [];
  let defaultPlan = OK_PLAN();
  let configured = true;
  let server;
  const state = { disconnects: 0 };

  function verify(req, audience) {
    const header = (req.headers.authorization || '').split(' ')[1] || '';
    try {
      const decoded = jwt.decode(header, { complete: true });
      if (decoded?.header?.alg !== 'ES256' || decoded.header.kid !== kid) return null;
      return jwt.verify(header, publicKey, { algorithms: ['ES256'], audience, issuer: 'syncos-node', clockTolerance: 5 });
    } catch {
      return null;
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/internal/v1/status') {
      if (!verify(req, 'syncos-ai:status')) return json(res, 401, { error: { code: 'TOKEN_INVALID' } });
      return json(res, 200, { configured, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 'stub', replayStore: 'memory', replayStoreHealthy: true });
    }
    if (req.method !== 'POST' || req.url !== '/internal/v1/generate') return json(res, 404, {});

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const claims = verify(req, 'syncos-ai:generate');
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ claims, body, headers: req.headers });
    if (!claims) return json(res, 401, { error: { code: 'TOKEN_INVALID' } });
    if (seenJti.has(claims.jti)) return json(res, 409, { error: { code: 'REPLAYED' } });
    seenJti.add(claims.jti);

    const plan = queue.shift() || defaultPlan;
    res.on('close', () => {
      if (!res.writableFinished) state.disconnects += 1;
    });
    if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    if (plan.status) return json(res, plan.status, plan.body || { error: { code: 'X' } });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    if (plan.firstFrameDelayMs) res.flushHeaders(); // really send the headers now, so the client is waiting for the FIRST FRAME (not the headers)
    if (plan.raw !== undefined) {
      res.end(plan.raw);
      return undefined;
    }
    if (plan.firstFrameDelayMs) await new Promise((resolve) => setTimeout(resolve, plan.firstFrameDelayMs)); // headers are out, the first frame is not yet
    for (const event of plan.frames || []) {
      res.write(typeof event === 'string' ? `${event}\n\n` : frameText(event)); // a string is written RAW (e.g. an SSE comment)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => (plan.gapMs ? setTimeout(resolve, plan.gapMs) : setImmediate(resolve)));
    }
    if (!plan.hangAfterFrames) res.end();
    return undefined;
  };

  return {
    requests,
    state,
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    enqueue(plan) {
      queue.push(plan);
      return this;
    },
    setDefault(plan) {
      defaultPlan = plan;
    },
    setConfigured(value) {
      configured = value;
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      seenJti.clear();
      state.disconnects = 0;
      defaultPlan = OK_PLAN();
      configured = true;
    },
    start: () => new Promise((resolve) => {
      server = http.createServer((req, res) => handler(req, res).catch(() => res.destroy()));
      server.listen(0, '127.0.0.1', resolve);
    }),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
    frame: frameText,
    DONE,
  };
}

module.exports = { createKeyPair, createStubAiService, frameText };
