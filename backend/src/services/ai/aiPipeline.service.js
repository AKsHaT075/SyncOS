const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../../config/env');
const AppError = require('../../utils/app-error');
const { DEFAULT_TIME_ZONE } = require('../../constants/calendar.constants');
const { AI_ERROR_CODES, AI_FEATURES, AI_PURPOSES, AI_USAGE_STATUS: STATUS } = require('../../constants/ai.constants');
const Organization = require('../../models/Organization');
const { isValidTimeZone } = require('../../utils/timezone');
const limits = require('./aiLimits.service');
const { assertAiAvailable, assertLiveDataAvailable } = require('./aiSettings.service');
const { recordUsage } = require('./aiUsageRecorder.service');
const aiService = require('./aiService');
const toolBudget = require('./tools/toolBudget.service');
const toolRuns = require('./tools/toolRuns');
const { resolveToolLimits, toolReservationTokens } = require('./tools/toolLimits');
const { estimateCostMicros, pricingVersion } = require('./pricing');
const { PERMISSIONS } = require('../../constants/permissions');
const { listToolDefinitions } = require('./aiToolRegistry');

/**
 * THE way product code talks to the model. Chat, RAG, tools and summaries all
 * go through here; nothing else may call a provider adapter.
 *
 * Order of operations for one logical request (provider retries happen INSIDE
 * step 5 and are invisible here, so a retry can never be billed twice):
 *
 *   1. assertAiAvailable   role permission, platform switch, key, org opt-in (live)
 *   2. admit               per-user rate limit + concurrency       (Redis, atomic)
 *   3. reserve             worst-case tokens vs user-daily AND org-monthly (Redis, atomic)
 *   4. [provider call]     only after 1-3 have passed
 *   5. settle              reservation -> actual charge            (idempotent)
 *   6. record              durable usage event in MongoDB (outbox on failure)
 *   7. release             in-flight slot
 *
 * Steps 5-7 run in `finally`, so they happen on success, provider errors and
 * cancellation (including a consumer that simply stops iterating).
 *
 * What gets charged:
 *   success + provider usage        -> the provider's real input+output total
 *   success, no usage metadata      -> estimate (chars/4), flagged `tokensEstimated`
 *   error/cancel BEFORE any output  -> 0 (full refund; nothing was delivered)
 *   error/cancel AFTER output began -> estimate of what was sent + produced (flagged)
 * A request that is refused by a quota is recorded as `denied` with 0 tokens.
 *
 * The usage record carries no prompt, completion, tool data or secrets.
 */

// Shown on a usage row only when Python could not tell us its model (e.g. a denied request before the first status probe).
const UNKNOWN_MODEL = 'unknown';

// The fixed system rules + delimiters around the sources (generous).
const RAG_PROMPT_OVERHEAD_TOKENS = 600;
// A follow-up question is first rewritten by a small extra model call (rules + its short output); the history is read once there.
const RAG_REWRITE_OVERHEAD_TOKENS = 400;

// Python adds the eight tool definitions and its tool rules to every model call of a tool-capable request (measured: ~1.6k input tokens
// on a one-line prompt). Reserve for them; the estimate never goes below this floor even if the registry is momentarily empty.
const TOOL_PROMPT_FLOOR_TOKENS = 1800;
function toolPromptTokens() {
  const defs = listToolDefinitions({ permissions: [PERMISSIONS.USE_AI] }).map(({ name, description, parameters }) => ({ name, description, parameters }));
  return Math.max(TOOL_PROMPT_FLOOR_TOKENS, Math.ceil(JSON.stringify(defs).length / 4) + 500);
}

/**
 * Cumulative usage snapshots (Step 8A). In live-tools mode Python reports, after every completed model round, EVERYTHING Groq has reported so far in
 * this request. Node keeps the LATEST valid snapshot and never adds them: 1,000 -> 2,400 -> 4,180 settles at 4,180. A snapshot is accepted only if it is
 * well formed (non-negative integers within sane bounds, total at least as large as input and output) and does not go BACKWARDS in input, output or total; anything else is ignored
 * and the previous valid snapshot stands. Repeats are harmless (idempotent). Tokens are Groq's reported prompt (which already includes the tool
 * definitions and any cached tokens, billed as prompt) and completion counts; nothing is estimated for a call that never reported.
 */
const USAGE_SNAPSHOT_MAX = 50_000_000;
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= USAGE_SNAPSHOT_MAX;
function acceptUsage(state, event) {
  const wellFormed = isCount(event.inputTokens) && isCount(event.outputTokens) && isCount(event.totalTokens) && event.totalTokens >= Math.max(event.inputTokens, event.outputTokens);
  const previous = state.usage;
  const backwards = previous && (event.inputTokens < previous.inputTokens || event.outputTokens < previous.outputTokens || event.totalTokens < previous.totalTokens);
  if (!wellFormed || backwards) {
    state.usageRejected += 1; // counted, never logged with values
    return false;
  }
  state.usage = { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, estimated: Boolean(event.estimated) };
  return true;
}

const estimateTokens = (messages, tools) => Math.ceil(JSON.stringify([messages, tools || []]).length / 4);
const charsToTokens = (chars) => Math.ceil(chars / 4);

function computeCharge({ status, started, usage, inputEstimate, outputChars }) {
  // Real numbers from the provider win whenever we have them, whatever the outcome.
  if (usage) {
    return { tokens: usage.totalTokens, input: usage.inputTokens, output: usage.outputTokens, estimated: Boolean(usage.estimated) };
  }
  if (status === STATUS.SUCCESS || started) {
    const output = charsToTokens(outputChars);
    return { tokens: inputEstimate + output, input: inputEstimate, output, estimated: true };
  }
  return { tokens: 0, input: 0, output: 0, estimated: false };
}

async function organizationTimeZone(organizationId) {
  const org = await Organization.findById(organizationId).select('settings.timezone').lean();
  const zone = org?.settings?.timezone;
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);

function validate({ feature, conversationId, messages, purpose }) {
  if (!Object.values(AI_PURPOSES).includes(purpose)) throw new AppError('Unknown AI purpose', 400, 'VALIDATION_ERROR');
  if (!Object.values(AI_FEATURES).includes(feature)) throw new AppError('Unknown AI feature', 400, 'VALIDATION_ERROR');
  if (conversationId && !mongoose.isValidObjectId(conversationId)) throw new AppError('Invalid conversation', 400, 'VALIDATION_ERROR');
  if (!Array.isArray(messages) || messages.length === 0) throw new AppError('A request needs at least one message', 400, 'VALIDATION_ERROR');
}

function baseEvent({ actor, feature, conversationId, requestKey, provider, model }) {
  return {
    organization: actor.organization,
    user: actor._id,
    feature,
    conversation: conversationId || null,
    requestKey,
    provider,
    model,
    pricingVersion: pricingVersion(),
    createdAt: new Date(),
  };
}

/**
 * Streams provider events for one metered request. Yields the same normalized
 * events as the provider (text / tool_calls / usage / done).
 *
 * options: { actor, feature, conversationId?, purpose?, messages, tools?, toolChoice?,
 *            temperature?, maxOutputTokens?, signal? }
 */
async function* streamAiRequest(options) {
  const { actor, feature, conversationId = null, purpose = AI_PURPOSES.CHAT, messages, tools, toolChoice, temperature, signal } = options;
  validate({ feature, conversationId, messages, purpose });

  // 1. The Phase 1 gate. Everything below only runs for a permitted, enabled, configured request.
  const { quotas } = await assertAiAvailable({ actor });
  // A tool budget is opened ONLY for a user and organization that may use live data RIGHT NOW (fresh identity, USE_AI, AI + live-data switches, and the
  // platform emergency switches, all re-read). This runs before any rate-limit slot, reservation or budget exists, so a refusal leaves nothing open.
  if (options.toolBudget) await assertLiveDataAvailable({ actor });

  const orgId = idOf(actor.organization);
  const userId = idOf(actor._id);
  const requestKey = options.requestKey || crypto.randomUUID();
  const platform = await aiService.platformStatus(); // cached readiness + the models Python reports
  const engine = aiService.getEngine();
  const model = platform.models?.[purpose] || UNKNOWN_MODEL;
  const outputCap = Math.min(options.maxOutputTokens || env.AI_MAX_OUTPUT_TOKENS, env.AI_MAX_OUTPUT_TOKENS);
  // Retrieval adds up to AI_RAG_CONTEXT_TOKENS of sources plus the fixed rules to what Groq reads: reserve for them up front
  // (settlement then replaces the reservation with Groq's real count, or with 0 when nothing was found and Groq was never called).
  const inputEstimate = estimateTokens(messages, tools) + (options.rag ? env.AI_RAG_CONTEXT_TOKENS + RAG_PROMPT_OVERHEAD_TOKENS : 0) + (options.rag?.history?.length ? RAG_REWRITE_OVERHEAD_TOKENS + 2 * charsToTokens(JSON.stringify(options.rag.history).length) : 0) + (options.toolBudget ? toolPromptTokens() : 0);
  // A request that may use tools (options.toolBudget) can make several model calls: reserve the bounded worst case UP FRONT
  // (see toolReservationTokens), then settle to the usage actually reported. Without it a request is exactly one call, as before.
  const toolLimits = options.toolBudget ? resolveToolLimits() : null;
  const reservedTokens = toolLimits ? toolReservationTokens({ baseInputTokens: inputEstimate, outputCap, limits: toolLimits }) : inputEstimate + outputCap;
  const event = baseEvent({ actor, feature, conversationId, requestKey, provider: platform.provider, model });

  // 2. Rate limit + concurrency (nothing is reserved if this refuses).
  await limits.admit({ orgId, userId, requestKey });

  // 3. Quota reservation (user daily + org monthly, atomically).
  let reservation;
  try {
    const timeZone = await organizationTimeZone(orgId);
    reservation = await limits.reserve({ orgId, userId, requestKey, amount: reservedTokens, quotas, timeZone });
  } catch (error) {
    await limits.release({ orgId, userId, requestKey });
    if (error.code && error.code.startsWith('AI_QUOTA')) {
      await recordUsage({ ...event, status: STATUS.DENIED, errorCode: error.code, reservedTokens, chargedTokens: 0 });
    }
    throw error;
  }

  // Tool callbacks are honoured only for a request that has an open budget. Fail closed: no budget, no tool-capable request.
  if (toolLimits) {
    try {
      await toolBudget.openBudget({ orgId, requestKey, limits: toolLimits });
    } catch (error) {
      await limits.settle({ reservation, actual: 0 }).catch(() => {});
      await limits.release({ orgId, userId, requestKey });
      throw error;
    }
  }

  const startedAt = Date.now();
  const state = { started: false, outputChars: 0, usage: null, usageRejected: 0, done: null, errorCode: null, aborted: false };

  try {
    // 4. The AI service call (Python retries Groq internally, before any output only; Node never retries).
    const identity = { userId, orgId, requestKey };
    for await (const providerEvent of engine.chat({ identity, purpose, messages, tools, toolChoice, temperature, maxOutputTokens: outputCap, signal, rag: options.rag, liveTools: Boolean(toolLimits) })) {
      if (providerEvent.type === 'text') {
        state.started = true;
        state.outputChars += providerEvent.text.length;
      } else if (providerEvent.type === 'tool_calls') {
        state.started = true;
        state.outputChars += providerEvent.calls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0);
      } else if (providerEvent.type === 'usage') {
        acceptUsage(state, providerEvent);
        if (toolLimits) continue; // live-tools mode: snapshots are Node's bookkeeping; the browser gets ONE final total, right before `done`
      } else if (providerEvent.type === 'done') {
        state.done = providerEvent;
        if (toolLimits && state.usage) yield { ...state.usage };
      }
      yield providerEvent;
    }
    if (!state.done) state.errorCode = AI_ERROR_CODES.INVALID_RESPONSE; // provider ended without a terminal event
  } catch (error) {
    state.errorCode = error.code || 'AI_INTERNAL_ERROR';
    state.aborted = error.code === AI_ERROR_CODES.ABORTED || Boolean(signal?.aborted);
    throw error;
  } finally {
    // Reached on success, on error, and when the consumer stops early (generator return()).
    await finalize({ state, event, reservation, orgId, userId, requestKey, inputEstimate, reservedTokens, startedAt, signal, tools: Boolean(toolLimits) });
  }
}

/** Steps 5-7. Never throws: a bookkeeping failure must not replace the real outcome. */
async function finalize({ state, event, reservation, orgId, userId, requestKey, inputEstimate, reservedTokens, startedAt, signal, tools = false }) {
  // The request is over: stop any tool still running for it, then read and remove its tool counters (usage records counts, nothing else).
  toolRuns.abortRequest(requestKey);
  const toolStats = tools ? await toolBudget.closeBudget({ orgId, requestKey }) : null;
  try {
    let status;
    let errorCode = state.errorCode;
    if (state.done && !errorCode) {
      status = STATUS.SUCCESS;
    } else if (state.aborted || (!errorCode && !state.done) || signal?.aborted) {
      status = STATUS.CANCELLED; // caller aborted, or simply stopped iterating
      errorCode = errorCode || AI_ERROR_CODES.ABORTED;
    } else {
      status = STATUS.ERROR;
    }

    // A tool-capable request streams NOTHING until its final answer, so `started` stays false through every tool round. But a tool that
    // ran proves at least one model round completed (and was paid for): a cancel / error / lost usage frame must not settle at zero.
    const toolRoundCompleted = Boolean(toolStats && toolStats.toolCalls > 0);
    const charge = computeCharge({ status, started: state.started || toolRoundCompleted, usage: state.usage, inputEstimate, outputChars: state.outputChars });

    let quotaSettled = true;
    try {
      await limits.settle({ reservation, actual: charge.tokens });
    } catch {
      quotaSettled = false; // fail closed: the reservation stays counted until the window rolls over
    }

    const usageModel = state.done?.model || event.model;
    await recordUsage({
      ...event,
      model: usageModel,
      providerRequestId: state.done?.requestId || null,
      status,
      errorCode: status === STATUS.SUCCESS ? null : errorCode,
      streamStarted: state.started,
      inputTokens: charge.input,
      outputTokens: charge.output,
      totalTokens: charge.input + charge.output,
      tokensEstimated: charge.estimated,
      reservedTokens,
      chargedTokens: charge.tokens,
      quotaSettled,
      ...(toolStats || {}),
      estimatedCostMicros: estimateCostMicros(usageModel, charge.input, charge.output),
      latencyMs: Date.now() - startedAt,
      firstEventMs: state.done?.firstEventMs ?? null,
    });
  } catch (error) {
    console.error('[ai-pipeline] finalize failed:', error.message);
  } finally {
    await limits.release({ orgId, userId, requestKey });
  }
}

/** Non-streaming variant: same gate, limits, quota and usage recording; returns the collected result. */
async function completeAiRequest(options) {
  const platform = await aiService.platformStatus();
  const model = platform.models?.[options.purpose || AI_PURPOSES.CHAT] || UNKNOWN_MODEL;
  return aiService.collectEvents(streamAiRequest(options), { provider: platform.provider, model });
}

module.exports = { completeAiRequest, computeCharge, estimateTokens, streamAiRequest };
