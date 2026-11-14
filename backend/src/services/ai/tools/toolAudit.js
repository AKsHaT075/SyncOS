const { AUDIT_EVENTS } = require('../../../constants/audit.constants');
const { logAudit } = require('../../audit.service');

/**
 * One audit row per identified tool call (success AND refusal). It records WHAT was looked up and how it went, never the data:
 *   - no question or prompt text (a callback does not even carry it),
 *   - no record content, descriptions, comments, names or any part of the result (only a record COUNT),
 *   - arguments only when the tool declared them safe (`auditFields`: enums, booleans, small numbers); everything else is
 *     reduced to its key name.
 * Best-effort: an audit failure is logged by name only and never replaces the call's own outcome.
 */

const SAFE_STRING = /^[A-Za-z0-9_ -]{1,40}$/;

function safeArguments(tool, input) {
  const allowed = new Set(tool?.auditFields || []);
  const args = {};
  const keys = [];
  for (const [key, value] of Object.entries(input && typeof input === 'object' ? input : {})) {
    keys.push(key);
    if (!allowed.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && SAFE_STRING.test(value))) args[key] = value;
  }
  return { argKeys: keys.slice(0, 20), args };
}

async function auditToolCall({ actor, tool, name, input, requestKey, callId, status, errorCode = null, durationMs = 0, records = null, bytes = null, req = null }) {
  try {
    await logAudit({
      action: AUDIT_EVENTS.AI_TOOL_INVOKED,
      userId: actor._id,
      organizationId: actor.organization,
      entityType: 'ai_tool',
      entityId: String(name).slice(0, 64),
      success: status === 'success',
      metadata: { tool: String(name).slice(0, 64), status, errorCode, durationMs: Math.round(durationMs), records, bytes, requestKey, callId: String(callId || '').slice(0, 64), ...safeArguments(tool, input) },
      req,
    });
  } catch (error) {
    console.error('[ai-tools] audit write failed:', error?.name || 'Error');
  }
}

module.exports = { auditToolCall, safeArguments };
