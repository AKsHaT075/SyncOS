const env = require('../../../config/env');
const { AI_ERROR_CODES: C, AI_LIVE_TOOL_NAMES } = require('../../../constants/ai.constants');
const { AiProviderError, make } = require('./errors');
const { readSse } = require('./sse');
const tokens = require('./tokens');

/**
 * Node's client for the Python AI service. Presents the SAME event contract the pipeline always
 * consumed (text / tool_calls / usage / done), so metering, quotas and usage recording are unchanged.
 *
 *   chat({ identity:{userId,orgId,requestKey}, purpose, messages, tools?, toolChoice?, temperature?,
 *          maxOutputTokens, signal? }) -> async iterable of events
 *
 * Rules (docs/ai/ai-service-contract.md):
 *  - A stream is complete only when a terminal `done` or `error` frame arrives. Anything else is a
 *    truncated stream and surfaces as AI_SERVICE_UNAVAILABLE (with `streamStarted` if output was seen).
 *  - NO retry here, ever. Python retries Groq before output; a second generate request would need a
 *    new single-use token and would double the provider spend. The pipeline's one reservation and
 *    one settlement therefore always match exactly one generate request.
 *  - Caller abort cancels the fetch, which makes Python cancel the Groq stream.
 *  - Errors carry only a normalized code: never Python's or Groq's text, never tokens or keys.
 */

const PROVIDER_CODES = new Set([
  C.NOT_CONFIGURED, C.RATE_LIMITED, C.TIMEOUT, C.UNAVAILABLE, C.AUTH, C.CONTEXT_TOO_LONG,
  C.CONTENT_FILTERED, C.TOOL_ERROR, C.BAD_REQUEST, C.ABORTED, C.INVALID_RESPONSE, C.RETRIEVAL_UNAVAILABLE,
]);

const C_TOOLS = new Set(AI_LIVE_TOOL_NAMES);
const count = (n) => Number.isFinite(n) && n >= 0;

function protocolError(started) {
  return make(C.SERVICE_PROTOCOL, { streamStarted: started });
}

function statusToError(status, code) {
  if (status === 401) return make(C.SERVICE_AUTH);
  if (status === 503 && code === 'NOT_CONFIGURED') return make(C.NOT_CONFIGURED);
  if (status === 503 && code === 'RETRIEVAL_DISABLED') return make(C.KNOWLEDGE_NOT_READY);
  if (status === 503 || status >= 500) return make(C.SERVICE_UNAVAILABLE);
  return make(C.SERVICE_PROTOCOL); // 409 replay, 413, 422: a bug on our side of the contract
}

async function errorCodeOf(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

/** Validates one frame from Python and returns the normalized event, or throws a protocol error. */
function toEvent(frame, started) {
  switch (frame?.type) {
    case 'text':
      if (typeof frame.text !== 'string') throw protocolError(started);
      return { type: 'text', text: frame.text };
    case 'tool_calls': {
      if (!Array.isArray(frame.calls)) throw protocolError(started);
      const calls = frame.calls.map((c) => {
        if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string') throw protocolError(started);
        return { id: c.id, name: c.name, arguments: c.arguments, input: c.input && typeof c.input === 'object' ? c.input : null, inputError: Boolean(c.inputError) };
      });
      return { type: 'tool_calls', calls };
    }
    case 'tool_activity': {
      // Exactly {type, tool} with a tool from the fixed list. Anything else (extra fields, unknown name, wrong type) is a protocol error:
      // this event is shown to people, so it is never forwarded loosely.
      const keys = Object.keys(frame);
      if (keys.length !== 2 || !keys.includes('type') || !keys.includes('tool') || typeof frame.tool !== 'string' || !C_TOOLS.has(frame.tool)) throw protocolError(started);
      return { type: 'tool_activity', tool: frame.tool };
    }
    case 'usage':
      if (![frame.inputTokens, frame.outputTokens, frame.totalTokens].every(count)) throw protocolError(started);
      return { type: 'usage', inputTokens: frame.inputTokens, outputTokens: frame.outputTokens, totalTokens: frame.totalTokens, estimated: Boolean(frame.estimated) };
    case 'retrieval': {
      const counts = ['candidates', 'authorized', 'rejected', 'belowThreshold', 'duplicates', 'used', 'rounds'];
      if (!counts.every((k) => Number.isInteger(frame[k]) && frame[k] >= 0)) throw protocolError(started);
      return { type: 'retrieval', ...Object.fromEntries(counts.map((k) => [k, frame[k]])), topScore: typeof frame.topScore === 'number' ? frame.topScore : null };
    }
    case 'citations': {
      if (!Array.isArray(frame.citations) || frame.citations.length > 100) throw protocolError(started);
      const citations = frame.citations.map((c) => {
        if (!c || !Number.isInteger(c.n) || typeof c.chunkId !== 'string' || typeof c.documentId !== 'string') throw protocolError(started);
        return { n: c.n, chunkId: c.chunkId, documentId: c.documentId, documentName: typeof c.documentName === 'string' ? c.documentName : '', version: Number.isInteger(c.version) ? c.version : null, chunkIndex: Number.isInteger(c.chunkIndex) ? c.chunkIndex : null, location: c.location && typeof c.location === 'object' ? c.location : {}, score: typeof c.score === 'number' ? c.score : null };
      });
      const unverified = Array.isArray(frame.unverifiedMarkers) ? frame.unverifiedMarkers.filter(Number.isInteger).slice(0, 50) : [];
      return { type: 'citations', citations, unverifiedMarkers: unverified, consideredSources: Number.isInteger(frame.consideredSources) ? frame.consideredSources : 0, uncited: Boolean(frame.uncited) };
    }
    case 'done':
      if (typeof frame.finishReason !== 'string') throw protocolError(started);
      return {
        type: 'done',
        finishReason: frame.finishReason,
        model: typeof frame.model === 'string' ? frame.model : null,
        provider: typeof frame.provider === 'string' ? frame.provider : null,
        requestId: typeof frame.requestId === 'string' ? frame.requestId : null,
        firstEventMs: count(frame.firstEventMs) ? frame.firstEventMs : null,
      };
    default:
      throw protocolError(started);
  }
}

function errorFromFrame(frame, started) {
  const code = PROVIDER_CODES.has(frame.code) ? frame.code : C.INVALID_RESPONSE;
  return make(code, {
    retryable: false, // the retry budget lives in Python and is already spent
    streamStarted: Boolean(frame.streamStarted) || started,
    upstreamStatus: Number.isInteger(frame.upstreamStatus) ? frame.upstreamStatus : null,
  });
}

async function* chat(params) {
  const { identity, purpose, messages, tools, toolChoice, temperature, maxOutputTokens, signal: callerSignal, rag } = params;
  // Live tools are authorized ONLY by Node's pipeline (a tool budget exists for this request). A document answer may use them too: the request then carries
  // BOTH tokens (knowledge:authorize and tool:execute, different headers, different scopes) and Python must verify both.
  const liveTools = params.liveTools === true;
  if (callerSignal?.aborted) throw make(C.ABORTED); // cancelled before we started: send nothing, burn no token

  const ctl = new AbortController();
  let cause = null;
  const abort = (why) => {
    if (!cause) {
      cause = why;
      ctl.abort();
    }
  };
  const signal = callerSignal ? AbortSignal.any([callerSignal, ctl.signal]) : ctl.signal;
  const total = setTimeout(() => abort('total'), env.AI_REQUEST_CEILING_MS);
  let phase = setTimeout(() => abort('connect'), env.AI_SERVICE_CONNECT_TIMEOUT_MS);
  const arm = (ms, why) => {
    clearTimeout(phase);
    phase = setTimeout(() => abort(why), ms);
  };

  const classify = (err) => {
    if (callerSignal?.aborted) return make(C.ABORTED);
    if (err instanceof AiProviderError) return err;
    if (cause) return make(C.SERVICE_TIMEOUT);
    return make(C.SERVICE_UNAVAILABLE);
  };

  let started = false;
  let terminal = false;
  try {
    let headers;
    try {
      headers = {
        Authorization: `Bearer ${tokens.signGenerateToken({ ...identity, maxOutputTokens, spaceId: rag?.spaceId, liveTools })}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        // Retrieval only: lets Python ask NODE which retrieved chunks this user may use, for THIS request only.
        ...(rag ? { 'X-Syncos-Callback-Token': tokens.signCallbackToken({ ...identity, scopes: [tokens.CALLBACK_SCOPES.KNOWLEDGE_AUTHORIZE] }) } : {}),
        // Live tools only: a DIFFERENT header and a different scope, bound to the same request id as the generate token above.
        ...(liveTools ? { 'X-Syncos-Tool-Token': tokens.signCallbackToken({ ...identity, scopes: [tokens.CALLBACK_SCOPES.TOOL_EXECUTE] }) } : {}),
      };
    } catch {
      throw make(C.NOT_CONFIGURED); // no/invalid signing key: nothing is sent
    }
    const body = rag ? JSON.stringify({ question: rag.question, ...(rag.history?.length ? { history: rag.history } : {}) }) : JSON.stringify({ purpose, messages, ...(tools?.length ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}), ...(temperature !== undefined ? { temperature } : {}) });

    let response;
    try {
      response = await fetch(`${env.AI_SERVICE_URL}${rag ? '/internal/v1/answer' : '/internal/v1/generate'}`, { method: 'POST', headers, body, signal });
    } catch (err) {
      throw classify(err);
    }
    if (!response.ok) throw statusToError(response.status, await errorCodeOf(response));
    if (!response.body) throw protocolError(false);

    arm(env.AI_SERVICE_FIRST_FRAME_TIMEOUT_MS, 'first_frame');
    try {
      // A keepalive proves Python is alive and working: it resets the idle timer (and satisfies the first-frame timer). It NEVER touches `total`, the
      // absolute request deadline, and only the exact keepalive line counts (see readSse).
      for await (const data of readSse(response.body, { onKeepalive: () => { if (!terminal) arm(env.AI_SERVICE_IDLE_TIMEOUT_MS, 'idle'); } })) {
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          throw protocolError(started);
        }
        if (frame?.type === 'error') {
          terminal = true;
          throw errorFromFrame(frame, started);
        }
        const event = toEvent(frame, started);
        // Only a frame that PASSED validation counts as activity (it satisfies the first-frame timer and resets the idle timer). A malformed or
        // unknown frame never reaches here (it throws above), and nothing here touches `total`: the absolute request deadline never moves.
        arm(env.AI_SERVICE_IDLE_TIMEOUT_MS, 'idle');
        if (event.type === 'text' || event.type === 'tool_calls') started = true;
        yield event;
        if (event.type === 'done') {
          terminal = true;
          return;
        }
      }
    } catch (err) {
      if (terminal && err instanceof AiProviderError) throw err;
      throw classify(err);
    }
    // The body ended with no terminal frame: a truncated stream is a failure, never a partial success.
    throw make(C.SERVICE_UNAVAILABLE, { streamStarted: started });
  } catch (err) {
    const error = err instanceof AiProviderError ? err : make(C.SERVICE_UNAVAILABLE);
    error.streamStarted = error.streamStarted || started;
    throw error;
  } finally {
    clearTimeout(total);
    clearTimeout(phase);
    ctl.abort(); // closes the connection if the consumer stopped early; Python then cancels the Groq stream
  }
}

/** Readiness of the AI service (`GET /internal/v1/status`). Never throws; unreachable == not configured. */
async function status() {
  if (!tokens.isSigningConfigured()) return { reachable: false, configured: false, reason: 'NO_SIGNING_KEY' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), env.AI_SERVICE_CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.AI_SERVICE_URL}/internal/v1/status`, {
      headers: { Authorization: `Bearer ${tokens.signStatusToken()}` },
      signal: ctl.signal,
    });
    if (!response.ok) return { reachable: true, configured: false, reason: response.status === 401 ? 'AUTH' : 'ERROR' };
    const body = await response.json();
    return {
      reachable: true,
      configured: body.configured === true && body.replayStoreHealthy !== false,
      provider: typeof body.provider === 'string' ? body.provider : 'groq',
      models: body.models && typeof body.models === 'object' ? body.models : {},
      version: typeof body.version === 'string' ? body.version : null,
      replayStore: typeof body.replayStore === 'string' ? body.replayStore : null,
      retrievalEnabled: typeof body.retrieval?.enabled === 'boolean' ? body.retrieval.enabled : null, // null = Python did not say
    };
  } catch {
    return { reachable: false, configured: false, reason: 'UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, name: 'ai-service', status };
