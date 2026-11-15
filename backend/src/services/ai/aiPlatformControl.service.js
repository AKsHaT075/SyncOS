const AppError = require('../../utils/app-error');
const { AUDIT_EVENTS } = require('../../constants/audit.constants');
const { AI_ERROR_CODES } = require('../../constants/ai.constants');
const AiPlatformControl = require('../../models/AiPlatformControl');
const { logAudit } = require('../audit.service');

/**
 * The platform emergency switches. One authority, server side, read FRESH on every check (no cache: a switch must take effect on the very
 * next request and the very next tool callback).
 *
 *   aiDisabled         all AI is refused (new requests AND tool callbacks)
 *   liveToolsDisabled  live organizational tools are refused (new tool budgets AND callbacks, and a tool that finishes after the flip is discarded)
 *
 * FAIL CLOSED: if the row cannot be read (database trouble) the answer is "everything is off", never "assume it is fine".
 * A row that does not exist yet is the normal initial state and means nothing is switched off.
 */
const READ_TIMEOUT_MS = 1500;

async function readControl() {
  try {
    const row = await AiPlatformControl.findOne({ _id: 'platform' }).maxTimeMS(READ_TIMEOUT_MS).lean();
    return { aiDisabled: Boolean(row?.aiDisabled), liveToolsDisabled: Boolean(row?.aiDisabled || row?.liveToolsDisabled), reason: row?.reason || null, unreadable: false };
  } catch {
    return { aiDisabled: true, liveToolsDisabled: true, reason: null, unreadable: true };
  }
}

/** Throws the fixed refusal when AI as a whole is switched off. */
async function assertPlatformAiOn() {
  const control = await readControl();
  if (control.aiDisabled) throw new AppError('AI is switched off for this platform', 403, AI_ERROR_CODES.DISABLED);
  return control;
}

/** Throws the fixed refusal when live tools (or all AI) are switched off. Distinct code, so callers can tell the switch from an organization setting. */
async function assertPlatformLiveToolsOn() {
  const control = await assertPlatformAiOn();
  if (control.liveToolsDisabled) throw new AppError('Live organizational tools are switched off for this platform', 403, AI_ERROR_CODES.PLATFORM_LIVE_TOOLS_DISABLED);
  return control;
}

const present = (control) => ({ aiDisabled: control.aiDisabled, liveToolsDisabled: control.liveToolsDisabled, reason: control.reason, readable: !control.unreadable });

async function getControl() {
  return present(await readControl());
}

/** Super-admin only (enforced by the route). Audited with the flags and a fixed reason code: never a prompt, result or free text. */
async function updateControl({ actor, changes, req }) {
  const before = await readControl();
  if (before.unreadable) throw new AppError('The platform control could not be read', 503, 'AI_CONTROL_UNAVAILABLE'); // do not write blind
  const next = {
    aiDisabled: changes.aiDisabled ?? before.aiDisabled,
    liveToolsDisabled: changes.liveToolsDisabled ?? before.liveToolsDisabled,
    reason: changes.reason ?? (changes.aiDisabled === false && changes.liveToolsDisabled === false ? null : before.reason),
  };
  // `liveToolsDisabled` as read folds in aiDisabled; store only what was explicitly set
  const stored = await AiPlatformControl.findOne({ _id: 'platform' }).lean();
  const set = { aiDisabled: next.aiDisabled, liveToolsDisabled: changes.liveToolsDisabled ?? Boolean(stored?.liveToolsDisabled), reason: next.reason, updatedBy: actor._id, updatedAt: new Date() };
  await AiPlatformControl.updateOne({ _id: 'platform' }, { $set: set }, { upsert: true });
  await logAudit({
    action: AUDIT_EVENTS.AI_PLATFORM_CONTROL_CHANGED,
    userId: actor._id,
    organizationId: null,
    entityType: 'ai_platform',
    entityId: 'platform',
    metadata: { aiDisabled: set.aiDisabled, liveToolsDisabled: set.liveToolsDisabled, reason: set.reason, previous: { aiDisabled: Boolean(stored?.aiDisabled), liveToolsDisabled: Boolean(stored?.liveToolsDisabled) } },
    req,
  });
  return getControl();
}

module.exports = { assertPlatformAiOn, assertPlatformLiveToolsOn, getControl, readControl, updateControl };
