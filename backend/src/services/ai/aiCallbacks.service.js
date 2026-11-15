const mongoose = require('mongoose');
const AppError = require('../../utils/app-error');
const { ROLE_PERMISSIONS } = require('../../constants/rolePermissions');
const User = require('../../models/User');
const limits = require('./aiLimits.service');
const { AI_TOOL_ERRORS: T } = require('../../constants/ai.constants');
const { assertAiAvailable, assertLiveDataAvailable, assertLiveToolsStillAllowed } = require('./aiSettings.service');
const { CALLBACK_SCOPES, verifyCallbackToken } = require('./aiService/tokens');
const { findTool, KINDS } = require('./aiToolRegistry');
const knowledge = require('./rag/knowledgeAccess.service');
const budget = require('./tools/toolBudget.service');
const { auditToolCall } = require('./tools/toolAudit');
const { resolveToolLimits } = require('./tools/toolLimits');
const { projectResult } = require('./tools/toolResult');
const toolRuns = require('./tools/toolRuns');

/**
 * Callbacks from the Python AI service into Node (docs/ai/ai-service-contract.md §8).
 *
 * Python is NOT trusted to say who may do what. Every callback independently:
 *   1. verifies a callback token (ES256, audience, scope, lifetime)
 *   2. requires that the request which minted it is STILL in flight (the token dies with the request)
 *   3. loads the user FRESH from the database (blocked / deactivated / moved org => refused)
 *   4. re-checks the AI gate (org switch, kill switch, USE_AI)
 *   5. (tool callbacks) re-checks that live organizational data is switched ON for the organization
 *   6. looks the tool up in NODE's registry, checks the user's permission for it, validates the arguments
 * Anything that fails 1-3 is the same generic 401; an unknown tool, a tool the user may not use, and a
 * non-executable tool are indistinguishable (404), so a tool list held by Python is no authorization.
 */

const unauthorized = () => new AppError('Unauthorized', 401, 'AI_CALLBACK_UNAUTHORIZED');
const toolNotFound = () => new AppError('Tool not found', 404, 'AI_TOOL_NOT_FOUND');
const hasPermission = (user, permission) => (ROLE_PERMISSIONS[user?.role] || []).includes(permission);

async function authorizeCallback({ token, scope }) {
  const claims = verifyCallbackToken(token); // throws the generic 401
  if (!claims.scopes.includes(scope)) throw new AppError('Forbidden', 403, 'AI_CALLBACK_SCOPE');
  if (!mongoose.isValidObjectId(claims.userId) || !mongoose.isValidObjectId(claims.orgId)) throw unauthorized();

  const inFlight = await limits.isInFlight({ orgId: claims.orgId, userId: claims.userId, requestKey: claims.requestKey });
  if (!inFlight) throw unauthorized();

  const user = await User.findById(claims.userId);
  if (!user || !user.isActive || user.orgBlocked || !user.organization || user.organization.toString() !== claims.orgId) throw unauthorized();
  if (scope === CALLBACK_SCOPES.TOOL_EXECUTE) await assertLiveDataAvailable({ actor: user }); // AI on + USE_AI + live data on, freshly read
  else await assertAiAvailable({ actor: user });
  return { actor: user, requestKey: claims.requestKey, orgId: claims.orgId };
}

const toolError = (message, status, code) => new AppError(message, status, code);

/** Rejects (never resolves late) once the signal aborts; the timer / abort listener is always cleaned up. */
function abortable(signal, work) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof AppError ? signal.reason : toolError('The lookup was cancelled', 499, T.ABORTED));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    return work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * Runs one tool for one callback. Order matters:
 *   token + live user + AI gate + LIVE-DATA gate -> registry lookup + permission -> argument validation -> tool BUDGET
 *   (calls, time, concurrency, duplicates; refused when Node never opened one for this request) -> execution under a deadline
 *   and an abort signal -> live-data gate AGAIN (it may have been switched off while the tool ran) -> allowlist projection and
 *   size limits -> audit. Every refusal after the user is identified is audited too.
 *
 * `signal` (optional) is the caller going away (the internal connection closing). The run is also aborted by its own deadline
 * and when the request ends (toolRuns.abortRequest, called by the pipeline).
 */
async function executeTool({ token, name, arguments: args, callId = null, signal: callerSignal = null, req = null }) {
  const { actor, requestKey, orgId } = await authorizeCallback({ token, scope: CALLBACK_SCOPES.TOOL_EXECUTE });
  const limits = resolveToolLimits();
  const started = Date.now();
  const tool = findTool(name);
  let acquired = false;
  let input = null;
  let outcome = { status: 'error', errorCode: T.FAILED };
  let projected = null;

  try {
    if (!tool || tool.kind !== KINDS.READ || !hasPermission(actor, tool.permission)) throw toolNotFound();

    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      // Paths only: never echo values the model produced.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].slice(0, 10);
      throw new AppError('Invalid tool arguments', 400, T.BAD_ARGUMENTS, { fields });
    }
    input = parsed.data;

    await budget.acquire({ orgId, requestKey, name, input });
    acquired = true;

    const remaining = await budget.remainingMs({ orgId, requestKey });
    const maxTimeMs = Math.max(1, Math.min(limits.callTimeoutMs, remaining || limits.callTimeoutMs));
    const controller = new AbortController();
    const untrack = toolRuns.track(requestKey, controller);
    const timer = setTimeout(() => controller.abort(toolError('The lookup took too long', 504, T.TIMEOUT)), maxTimeMs);
    const onCallerGone = () => controller.abort(toolError('The lookup was cancelled', 499, T.ABORTED));
    if (callerSignal) {
      if (callerSignal.aborted) onCallerGone();
      else callerSignal.addEventListener('abort', onCallerGone, { once: true });
    }
    let raw;
    try {
      raw = await abortable(controller.signal, Promise.resolve().then(() => tool.run({ actor, input, signal: controller.signal, maxTimeMs })));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason instanceof AppError ? controller.signal.reason : toolError('The lookup was cancelled', 499, T.ABORTED);
      throw toolError('The lookup failed', 500, T.FAILED); // generic: never the text of an unexpected error
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerGone);
      untrack();
    }

    // Live data may have been switched off (or the user blocked / AI disabled) WHILE the tool ran: then nothing is returned.
    await assertLiveToolsStillAllowed({ organization: actor.organization }); // org switches AND the platform emergency switch, read fresh

    projected = projectResult(tool, raw, limits);
    outcome = { status: 'success', errorCode: null };
    return { result: projected.result };
  } catch (error) {
    outcome = { status: 'refused', errorCode: error instanceof AppError ? error.code : T.FAILED };
    throw error;
  } finally {
    const durationMs = Date.now() - started;
    if (acquired) await budget.release({ orgId, requestKey, ms: durationMs, failed: outcome.status !== 'success' });
    await auditToolCall({
      actor, tool, name, input, requestKey, callId, status: outcome.status, errorCode: outcome.errorCode, durationMs,
      records: projected?.meta.records ?? null, bytes: projected?.meta.bytes ?? null, req,
    });
  }
}

/**
 * Python asks which retrieved chunks the user may use. Same gate as every callback (token, request still in flight, user
 * re-loaded fresh, AI gate re-run), then the document access rules. Returns text ONLY for chunks that pass.
 */
async function authorizeKnowledge({ token, candidates }) {
  const { actor, requestKey } = await authorizeCallback({ token, scope: CALLBACK_SCOPES.KNOWLEDGE_AUTHORIZE });
  return knowledge.authorizeChunks({ actor, candidates, requestKey });
}

module.exports = { authorizeCallback, authorizeKnowledge, executeTool };
