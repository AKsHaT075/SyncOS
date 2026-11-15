const env = require('../../config/env');
const AppError = require('../../utils/app-error');
const { AUDIT_EVENTS } = require('../../constants/audit.constants');
const { AI_DISCLOSURE, AI_ERROR_CODES, AI_LIVE_DATA_DISCLOSURE, AI_QUOTA_DEFAULTS } = require('../../constants/ai.constants');
const { PERMISSIONS } = require('../../constants/permissions');
const { ROLE_PERMISSIONS } = require('../../constants/rolePermissions');
const AiOrgSettings = require('../../models/AiOrgSettings');
const { capAiQuotas } = require('../planLimits.service');
const { logAudit } = require('../audit.service');
const platformControl = require('./aiPlatformControl.service');
const { platformStatus } = require('./aiService');

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);

function hasPermission(user, permission) {
  return (ROLE_PERMISSIONS[user?.role] || []).includes(permission);
}

function effectiveQuotas(row) {
  return {
    userDailyTokens: row?.quotas?.userDailyTokens ?? AI_QUOTA_DEFAULTS.userDailyTokens,
    orgMonthlyTokens: row?.quotas?.orgMonthlyTokens ?? AI_QUOTA_DEFAULTS.orgMonthlyTokens,
  };
}

function present(row) {
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabledAt || null,
    disabledAt: row?.disabledAt || null,
    disclosure: {
      acceptedVersion: row?.disclosure?.version || null,
      acceptedAt: row?.disclosure?.acceptedAt || null,
      acceptedBy: idOf(row?.disclosure?.acceptedBy),
      currentVersion: AI_DISCLOSURE.version,
      needsReacceptance: Boolean(row?.enabled) && row?.disclosure?.version !== AI_DISCLOSURE.version,
    },
    // Live data only counts while AI itself is on (turning AI off also turns it off; this guards legacy/inconsistent rows too).
    liveDataEnabled: Boolean(row?.enabled) && Boolean(row?.liveDataEnabled),
    liveData: {
      enabledAt: row?.liveDataEnabledAt || null,
      disabledAt: row?.liveDataDisabledAt || null,
      disclosure: {
        acceptedVersion: row?.liveDataDisclosure?.version || null,
        acceptedAt: row?.liveDataDisclosure?.acceptedAt || null,
        acceptedBy: idOf(row?.liveDataDisclosure?.acceptedBy),
        currentVersion: AI_LIVE_DATA_DISCLOSURE.version,
        needsReacceptance: Boolean(row?.liveDataEnabled) && row?.liveDataDisclosure?.version !== AI_LIVE_DATA_DISCLOSURE.version,
      },
    },
    quotas: effectiveQuotas(row),
    quotaDefaults: { ...AI_QUOTA_DEFAULTS },
  };
}

async function loadRow(organizationId) {
  return AiOrgSettings.findOne({ organization: organizationId });
}

/** Policy for the disclosure shown before enabling. Static text; no tenant data. */
function getDisclosure() {
  return { ...AI_DISCLOSURE, points: [...AI_DISCLOSURE.points] };
}

/** The separate disclosure for live organizational data. Static text; no tenant data. */
function getLiveDataDisclosure() {
  return { ...AI_LIVE_DATA_DISCLOSURE, points: [...AI_LIVE_DATA_DISCLOSURE.points] };
}

/**
 * Why AI can/can't be used by this person right now. Never throws; safe to call
 * from the UI to decide what to render. Contains no secrets.
 */
async function getStatus({ actor }) {
  const platform = await platformStatus();
  const row = await loadRow(actor.organization);
  const orgEnabled = Boolean(row?.enabled);

  let reason = null;
  if (!hasPermission(actor, PERMISSIONS.USE_AI)) reason = 'NO_ACCESS';
  else if (!platform.globalEnabled) reason = 'PLATFORM_DISABLED';
  else if (!platform.configured) reason = 'NOT_CONFIGURED';
  else if (!orgEnabled) reason = 'ORG_DISABLED';

  return {
    ready: reason === null,
    reason,
    organizationEnabled: orgEnabled,
    liveDataEnabled: orgEnabled && Boolean(row?.liveDataEnabled),
    provider: platform.provider,
    canManage: hasPermission(actor, PERMISSIONS.MANAGE_AI),
  };
}

async function getSettings({ actor }) {
  const row = await loadRow(actor.organization);
  const platform = await platformStatus();
  return {
    settings: present(row),
    platform: { provider: platform.provider, configured: platform.configured, globalEnabled: platform.globalEnabled, models: platform.models },
    disclosure: getDisclosure(),
    liveDataDisclosure: getLiveDataDisclosure(),
  };
}

async function updateSettings({ actor, body, req }) {
  const organization = actor.organization;
  const row = (await loadRow(organization)) || new AiOrgSettings({ organization });
  const wasEnabled = Boolean(row.enabled);
  const wasLive = Boolean(row.liveDataEnabled);
  const changes = [];
  const quotasBefore = effectiveQuotas(row);

  if (body.enabled === true && !wasEnabled) {
    const platform = await platformStatus();
    if (!platform.globalEnabled) throw new AppError('AI is switched off for this platform', 409, AI_ERROR_CODES.DISABLED);
    if (!platform.configured) throw new AppError('AI is not configured on this server', 503, AI_ERROR_CODES.NOT_CONFIGURED);
    if (body.acceptDisclosureVersion !== AI_DISCLOSURE.version) {
      throw new AppError('You must accept the current AI disclosure before enabling AI', 400, 'DISCLOSURE_REQUIRED', {
        requiredVersion: AI_DISCLOSURE.version,
      });
    }
    row.enabled = true;
    row.enabledAt = new Date();
    row.disclosure = { version: AI_DISCLOSURE.version, provider: platform.provider, acceptedBy: actor._id, acceptedAt: new Date() };
  } else if (body.enabled === false && wasEnabled) {
    row.enabled = false;
    row.disabledAt = new Date();
  }

  // Live organizational data. Needs AI on, and its OWN disclosure when switching on. Turning AI off turns it off too.
  let liveChange = null; // 'enabled' | 'disabled' | 'disabled_with_ai'
  if (body.liveDataEnabled === true && !wasLive) {
    if (!row.enabled) throw new AppError('Turn AI on before enabling live data', 409, AI_ERROR_CODES.LIVE_DATA_REQUIRES_AI);
    if (body.acceptLiveDataDisclosureVersion !== AI_LIVE_DATA_DISCLOSURE.version) {
      throw new AppError('You must accept the live data disclosure before enabling it', 400, 'DISCLOSURE_REQUIRED', { requiredVersion: AI_LIVE_DATA_DISCLOSURE.version });
    }
    row.liveDataEnabled = true;
    row.liveDataEnabledAt = new Date();
    row.liveDataDisclosure = { version: AI_LIVE_DATA_DISCLOSURE.version, acceptedBy: actor._id, acceptedAt: new Date() };
    liveChange = 'enabled';
  } else if ((body.liveDataEnabled === false && wasLive) || (!row.enabled && wasLive)) {
    row.liveDataEnabled = false;
    row.liveDataDisabledAt = new Date();
    liveChange = body.liveDataEnabled === false ? 'disabled' : 'disabled_with_ai';
  }

  if (body.quotas) {
    for (const key of ['userDailyTokens', 'orgMonthlyTokens']) {
      if (body.quotas[key] !== undefined && (row.quotas?.[key] ?? null) !== body.quotas[key]) {
        row.set(`quotas.${key}`, body.quotas[key]);
        changes.push(key);
      }
    }
  }

  const enabledChanged = Boolean(row.enabled) !== wasEnabled;
  if (!enabledChanged && !liveChange && changes.length === 0) return { settings: present(row) }; // nothing to persist (no row is created for a no-op)

  row.updatedBy = actor._id;
  await row.save();

  const base = { entityType: 'ai_settings', entityId: idOf(row._id), organizationId: organization, userId: idOf(actor._id), req };
  if (enabledChanged) {
    await logAudit({
      ...base,
      action: row.enabled ? AUDIT_EVENTS.AI_ENABLED : AUDIT_EVENTS.AI_DISABLED,
      metadata: row.enabled ? { disclosureVersion: AI_DISCLOSURE.version, provider: row.disclosure.provider } : {},
    });
  }
  if (liveChange) {
    await logAudit({
      ...base,
      action: liveChange === 'enabled' ? AUDIT_EVENTS.AI_LIVE_DATA_ENABLED : AUDIT_EVENTS.AI_LIVE_DATA_DISABLED,
      metadata: liveChange === 'enabled' ? { disclosureVersion: AI_LIVE_DATA_DISCLOSURE.version } : { reason: liveChange === 'disabled_with_ai' ? 'ai_disabled' : 'admin' },
    });
  }
  if (changes.length) {
    await logAudit({ ...base, action: AUDIT_EVENTS.AI_SETTINGS_UPDATED, metadata: { fields: changes, from: quotasBefore, to: effectiveQuotas(row) } });
  }

  return { settings: present(row) };
}

/**
 * The single gate every AI request (chat, retrieval, tools, ingestion triggers)
 * must pass. Evaluated live on every call: switching AI off, or changing a
 * role, takes effect on the very next request.
 */
async function assertAiAvailable({ actor }) {
  if (!actor?.organization) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  if (actor.orgBlocked || actor.isActive === false) throw new AppError('Your access to this organization is blocked', 403, 'ORG_BLOCKED');
  if (!hasPermission(actor, PERMISSIONS.USE_AI)) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  const platform = await platformStatus();
  if (!platform.globalEnabled) throw new AppError('AI is switched off for this platform', 403, AI_ERROR_CODES.DISABLED);
  await platformControl.assertPlatformAiOn(); // the runtime emergency switch (fail closed), read fresh
  if (!platform.configured) throw new AppError('AI is not configured on this server', 503, AI_ERROR_CODES.NOT_CONFIGURED);
  const row = await AiOrgSettings.findOne({ organization: actor.organization }).select('enabled liveDataEnabled quotas').lean();
  if (!row?.enabled) throw new AppError('AI is not enabled for this organization', 403, AI_ERROR_CODES.DISABLED);
  return { quotas: await capAiQuotas(actor.organization, effectiveQuotas(row)), liveDataEnabled: Boolean(row.liveDataEnabled) };
}

/**
 * The gate for anything that reads LIVE organizational data (every tool callback): everything assertAiAvailable checks, plus the
 * organization's own liveDataEnabled switch. Evaluated live on every call, so switching live data off stops the very next tool
 * execution, even inside a conversation that is already running.
 */
async function assertLiveDataAvailable({ actor }) {
  const gate = await assertAiAvailable({ actor });
  await platformControl.assertPlatformLiveToolsOn(); // the platform emergency switch for live tools (fail closed), read fresh
  if (!gate.liveDataEnabled) throw new AppError('Live organizational data is not enabled for this organization', 403, AI_ERROR_CODES.LIVE_DATA_DISABLED);
  return gate;
}

/**
 * May live tools be OFFERED to this user for a new request? Never throws. Everything must hold, each read fresh: the deploy-time activation flag,
 * the user's identity and USE_AI, the platform AI + live-tool emergency switches, and the organization's `enabled` + `liveDataEnabled`.
 * Anything unreadable or refused means "no": the request then simply continues WITHOUT tools (and without opening a budget).
 */
async function liveToolsEligibility({ actor }) {
  if (!env.AI_LIVE_TOOLS_ENABLED) return { eligible: false, reason: 'not_activated' };
  try {
    await assertLiveDataAvailable({ actor });
    return { eligible: true, reason: null };
  } catch (error) {
    return { eligible: false, reason: error.code || 'unavailable' };
  }
}

/** The cheap re-check a tool runs after it finished (and before its result is returned): switched off meanwhile? Throws the same refusals as the gate. */
async function assertLiveToolsStillAllowed({ organization }) {
  await platformControl.assertPlatformLiveToolsOn();
  const row = await AiOrgSettings.findOne({ organization }).select('enabled liveDataEnabled').lean();
  if (!row?.enabled) throw new AppError('AI is not enabled for this organization', 403, AI_ERROR_CODES.DISABLED);
  if (!row.liveDataEnabled) throw new AppError('Live organizational data is not enabled for this organization', 403, AI_ERROR_CODES.LIVE_DATA_DISABLED);
}

/** Super-admin: platform-level provider health. No tenant content; only an aggregate count. */
async function getPlatformStatus() {
  const platform = await platformStatus();
  const organizationsEnabled = await AiOrgSettings.countDocuments({ enabled: true });
  return {
    provider: platform.provider,
    configured: platform.configured,
    globalEnabled: platform.globalEnabled,
    models: platform.models,
    service: { reachable: platform.reachable, version: platform.version, replayStore: platform.replayStore },
    limits: {
      requestCeilingMs: env.AI_REQUEST_CEILING_MS,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    },
    organizationsEnabled,
  };
}

/** Effective quotas for an org (its overrides, else platform defaults). */
async function getEffectiveQuotas(organizationId) {
  const row = await AiOrgSettings.findOne({ organization: organizationId }).select('quotas').lean();
  return capAiQuotas(organizationId, effectiveQuotas(row));
}

module.exports = { assertAiAvailable, assertLiveDataAvailable, assertLiveToolsStillAllowed, liveToolsEligibility, getDisclosure, getLiveDataDisclosure, getEffectiveQuotas, getPlatformStatus, getSettings, getStatus, updateSettings };
