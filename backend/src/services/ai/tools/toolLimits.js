const env = require('../../../config/env');

/**
 * The limits one request's tool use runs under, resolved from configuration. All of them live INSIDE the global request ceiling
 * (AI_REQUEST_CEILING_MS); none of them raises it.
 */
function resolveToolLimits() {
  return Object.freeze({
    maxRounds: env.AI_TOOL_MAX_ROUNDS,
    maxCalls: env.AI_TOOL_MAX_CALLS,
    maxConcurrent: env.AI_TOOL_MAX_CONCURRENT,
    callTimeoutMs: env.AI_TOOL_TIMEOUT_MS,
    totalMs: env.AI_TOOL_TOTAL_MS,
    maxResultBytes: env.AI_TOOL_MAX_RESULT_BYTES,
    maxRecords: env.AI_TOOL_MAX_RECORDS,
    maxStringChars: env.AI_TOOL_MAX_STRING_CHARS,
    maxDepth: env.AI_TOOL_MAX_DEPTH,
  });
}

const charsToTokens = (chars) => Math.ceil(chars / 4);

/**
 * The limits Node sends to Python INSIDE the signed generate token (claim `tl`), so Python can only ever tighten them, never exceed
 * them, with no manual synchronization of two sets of environment variables. Refuses (throws) a configuration that cannot work or
 * would let tools outlive the request: the request then never starts (fail closed). Short keys keep the token small.
 *   r rounds, c calls, k concurrent, t per-call ms, m total tool ms, b result bytes, d request ceiling ms
 */
function limitsClaim(limits = resolveToolLimits(), ceilingMs = env.AI_REQUEST_CEILING_MS) {
  // A call can never run longer than the whole tool budget (Node shrinks each call's deadline to what is left), so t is capped by m.
  const values = { r: limits.maxRounds, c: limits.maxCalls, k: limits.maxConcurrent, t: Math.min(limits.callTimeoutMs, limits.totalMs), m: limits.totalMs, b: limits.maxResultBytes, d: ceilingMs };
  const ok = Object.values(values).every((v) => Number.isInteger(v) && v > 0)
    && limits.maxConcurrent <= limits.maxCalls
    && limits.totalMs + 10000 <= ceilingMs; // tool time must fit inside the request with room for model calls
  if (!ok) throw new Error('The live-tool limits are inconsistent'); // never names a value
  return values;
}

/**
 * Worst-case tokens a request that may use tools can spend, reserved UP FRONT (nothing is unmetered) and settled afterwards to
 * the usage Python actually reports.
 *
 *   rounds        = maxRounds tool rounds + 1 final answer = R + 1 model calls
 *   input         every call re-reads the prompt: (R + 1) x baseInputTokens
 *   tool results  at most maxCalls x maxResultBytes of results exist in total; in the worst case they all arrive in round 1
 *                 and are re-read by each of the remaining R calls: R x resultTokens
 *   output        each call may produce up to outputCap tokens: (R + 1) x outputCap
 */
function toolReservationTokens({ baseInputTokens, outputCap, limits = resolveToolLimits() }) {
  const calls = limits.maxRounds + 1;
  const resultTokens = limits.maxCalls * charsToTokens(limits.maxResultBytes);
  return calls * baseInputTokens + limits.maxRounds * resultTokens + calls * outputCap;
}

/**
 * Startup check (server.js): when live tools are ACTIVATED, an inconsistent AI_TOOL_* / AI_REQUEST_CEILING_MS configuration stops the server from starting,
 * instead of failing every tool request later. Does nothing while AI_LIVE_TOOLS_ENABLED is off (the default). Never names a value.
 */
function assertLiveToolsConfig({ enabled = env.AI_LIVE_TOOLS_ENABLED } = {}) {
  if (!enabled) return false;
  limitsClaim(); // throws 'The live-tool limits are inconsistent'
  return true;
}

module.exports = { assertLiveToolsConfig, limitsClaim, resolveToolLimits, toolReservationTokens };
