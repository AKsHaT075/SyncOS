const env = require('../../../config/env');
const client = require('./client');
const { estimateCostMicros } = require('../pricing');

/**
 * The seam between product code and the AI engine. Production: the Python AI service over HTTP.
 * Tests inject a fake with setEngine(). Nothing else in Node knows how generation is done.
 *
 * Engine contract:  chat(params) -> async iterable of events ;  status() -> { configured, provider, models, ... }
 */

let engine = client;
let cache = null; // { at, value }
let inflight = null;

const FAILURE_TTL_MS = 3000; // re-probe an unreachable service quickly, but never once per request

function setEngine(next) {
  engine = next;
  cache = null;
  inflight = null;
}

function resetEngine() {
  setEngine(client);
}

function getEngine() {
  return engine;
}

function invalidateStatus() {
  cache = null;
  inflight = null;
}

async function refresh() {
  let raw;
  try {
    raw = await engine.status();
  } catch {
    raw = { reachable: false, configured: false };
  }
  const configured = Boolean(raw?.configured);
  return {
    provider: raw?.provider || 'groq',
    configured,
    reachable: raw?.reachable !== false,
    models: raw?.models || {},
    version: raw?.version || null,
    replayStore: raw?.replayStore || null,
    retrievalEnabled: typeof raw?.retrievalEnabled === 'boolean' ? raw.retrievalEnabled : null,
  };
}

/**
 * Whether the platform can serve AI right now (kill switch + AI service reachable and configured).
 * Cached briefly so the gate does not add a network hop to every request; fails closed.
 */
async function platformStatus() {
  const service = await cachedServiceStatus();
  // The kill switch is Node's own setting: read live on every call, never from the cache.
  return { ...service, globalEnabled: env.AI_GLOBAL_ENABLED, available: service.configured && env.AI_GLOBAL_ENABLED };
}

async function cachedServiceStatus() {
  const now = Date.now();
  if (cache && now - cache.at < (cache.value.configured ? env.AI_SERVICE_STATUS_TTL_MS : FAILURE_TTL_MS)) return cache.value;
  if (!inflight) {
    inflight = refresh()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Folds an event stream into one result (used by non-streaming callers). */
async function collectEvents(events, { provider, model, startedAt = Date.now() }) {
  let text = '';
  let toolCalls = [];
  let usage = null;
  let finishReason = null;
  let requestId = null;
  let firstEventMs = null;
  let reportedModel = model;

  for await (const event of events) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'tool_calls') toolCalls = event.calls;
    else if (event.type === 'usage') usage = event;
    else if (event.type === 'done') {
      finishReason = event.finishReason;
      requestId = event.requestId;
      firstEventMs = event.firstEventMs;
      reportedModel = event.model || model;
    }
  }

  return {
    text,
    toolCalls,
    finishReason,
    requestId,
    provider,
    model: reportedModel,
    usage: usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimated: usage.estimated,
      estimatedCostMicros: estimateCostMicros(reportedModel, usage.inputTokens, usage.outputTokens),
    },
    latencyMs: Date.now() - startedAt,
    firstEventMs,
  };
}

module.exports = { collectEvents, getEngine, invalidateStatus, platformStatus, resetEngine, setEngine };
