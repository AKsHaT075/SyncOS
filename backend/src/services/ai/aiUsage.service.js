const mongoose = require('mongoose');
const env = require('../../config/env');
const AiUsageEvent = require('../../models/AiUsageEvent');
const Organization = require('../../models/Organization');
const { DEFAULT_TIME_ZONE } = require('../../constants/calendar.constants');
const { AI_USAGE_STATUS: STATUS } = require('../../constants/ai.constants');
const { resolveRange } = require('../../utils/analyticsRange');
const { isValidTimeZone } = require('../../utils/timezone');
const { personNames, run } = require('../analytics/common');
const { readCounters } = require('./aiLimits.service');
const { getEffectiveQuotas } = require('./aiSettings.service');
const { pricingVersion } = require('./pricing');

/**
 * Usage reporting over AiUsageEvent. Every query is scoped by organization
 * (`getPlatformUsage` is the one deliberate exception: aggregate numbers for
 * super-admin, never rows, names, or per-tenant breakdowns). The events hold
 * no prompt or completion text, so nothing here can leak conversation content.
 *
 * Money is an ESTIMATE in USD from the price table active when the event was
 * recorded; events for models without a price are counted, not guessed.
 */

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const usd = (micros) => Number(((micros || 0) / 1e6).toFixed(6));
const when = (condition) => ({ $cond: [condition, 1, 0] });
const isStatus = (status) => ({ $eq: ['$status', status] });
const isUnpriced = { $eq: [{ $ifNull: ['$estimatedCostMicros', null] }, null] };

async function organizationTimeZone(organizationId) {
  const org = await Organization.findById(organizationId).select('settings.timezone').lean();
  const zone = org?.settings?.timezone;
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

const metrics = {
  requests: { $sum: 1 },
  successes: { $sum: when(isStatus(STATUS.SUCCESS)) },
  errors: { $sum: when(isStatus(STATUS.ERROR)) },
  cancelled: { $sum: when(isStatus(STATUS.CANCELLED)) },
  denied: { $sum: when(isStatus(STATUS.DENIED)) },
  inputTokens: { $sum: '$inputTokens' },
  outputTokens: { $sum: '$outputTokens' },
  totalTokens: { $sum: '$totalTokens' },
  estimatedTokenRequests: { $sum: when({ $eq: ['$tokensEstimated', true] }) },
  costMicros: { $sum: '$estimatedCostMicros' }, // nulls are ignored
  unpricedRequests: { $sum: when({ $and: [isUnpriced, { $gt: ['$totalTokens', 0] }] }) },
  avgLatencyMs: { $avg: { $cond: [isStatus(STATUS.SUCCESS), '$latencyMs', null] } },
};

function present(row = {}) {
  const requests = row.requests || 0;
  return {
    requests,
    successes: row.successes || 0,
    errors: row.errors || 0,
    cancelled: row.cancelled || 0,
    denied: row.denied || 0,
    inputTokens: row.inputTokens || 0,
    outputTokens: row.outputTokens || 0,
    totalTokens: row.totalTokens || 0,
    estimatedTokenRequests: row.estimatedTokenRequests || 0,
    estimatedCostUsd: usd(row.costMicros),
    unpricedRequests: row.unpricedRequests || 0,
    avgLatencyMs: row.avgLatencyMs == null ? null : Math.round(row.avgLatencyMs),
  };
}

const NOTES = [
  'Costs are estimates from the price table in effect when each request ran, not invoices.',
  'Requests where the provider reported no token counts use an estimate (about 4 characters per token).',
  'Requests refused by a quota are listed as "denied" and use no tokens.',
];

async function breakdown(match, groupField, { limit = 20, sortField = 'totalTokens' } = {}) {
  return run(AiUsageEvent, [{ $match: match }, { $group: { _id: groupField, ...metrics } }, { $sort: { [sortField]: -1 } }, { $limit: limit }]);
}

async function series(match, range) {
  const rows = await run(AiUsageEvent, [
    { $match: match },
    { $group: { _id: { $dateToString: { format: range.format, date: '$createdAt', timezone: range.timeZone } }, requests: { $sum: 1 }, totalTokens: { $sum: '$totalTokens' }, costMicros: { $sum: '$estimatedCostMicros' } } },
  ]);
  const byBucket = new Map(rows.map((row) => [row._id, row]));
  return range.buckets.map((bucket) => {
    const row = byBucket.get(bucket) || {};
    return { bucket, requests: row.requests || 0, totalTokens: row.totalTokens || 0, estimatedCostUsd: usd(row.costMicros) };
  });
}

const rangeInfo = (range) => ({ from: range.from, to: range.to, timeZone: range.timeZone, granularity: range.granularity });

/** A member's own usage and remaining personal quota. */
async function getMyUsage({ actor, query = {} }) {
  const timeZone = await organizationTimeZone(actor.organization);
  const range = resolveRange(query, timeZone);
  const match = { organization: oid(actor.organization), user: oid(actor._id), createdAt: { $gte: range.start, $lt: range.end } };

  const [quotas, counters, totals, daily, byFeature] = await Promise.all([
    getEffectiveQuotas(actor.organization),
    readCounters({ orgId: idOf(actor.organization), userId: idOf(actor._id), timeZone }),
    run(AiUsageEvent, [{ $match: match }, { $group: { _id: null, ...metrics } }]),
    series(match, range),
    breakdown(match, '$feature'),
  ]);

  return {
    range: rangeInfo(range),
    quota: counters
      ? {
          available: true,
          dailyLimit: quotas.userDailyTokens,
          dailyUsed: counters.userDailyUsed,
          dailyRemaining: Math.max(0, quotas.userDailyTokens - counters.userDailyUsed),
          resetsAt: counters.dayResetsAt,
        }
      : { available: false, dailyLimit: quotas.userDailyTokens }, // counters unreadable: say so, never show a fake zero
    totals: present(totals[0]),
    series: daily,
    byFeature: byFeature.map((row) => ({ feature: row._id, ...present(row) })),
    notes: NOTES,
    pricingVersion: pricingVersion(),
  };
}

/** Organization-wide usage for admins (VIEW_AI_USAGE). Per-person totals only, never content. */
async function getOrgUsage({ actor, query = {} }) {
  const timeZone = await organizationTimeZone(actor.organization);
  const range = resolveRange(query, timeZone);
  const match = { organization: oid(actor.organization), createdAt: { $gte: range.start, $lt: range.end } };

  const [quotas, counters, totals, daily, byFeature, byModel, byUser, byError] = await Promise.all([
    getEffectiveQuotas(actor.organization),
    readCounters({ orgId: idOf(actor.organization), userId: idOf(actor._id), timeZone }),
    run(AiUsageEvent, [{ $match: match }, { $group: { _id: null, ...metrics } }]),
    series(match, range),
    breakdown(match, '$feature'),
    breakdown(match, { provider: '$provider', model: '$model' }),
    breakdown(match, '$user', { limit: 20 }),
    run(AiUsageEvent, [
      { $match: { ...match, status: { $ne: STATUS.SUCCESS } } },
      { $group: { _id: '$errorCode', requests: { $sum: 1 } } },
      { $sort: { requests: -1 } },
      { $limit: 10 },
    ]),
  ]);
  const names = await personNames(byUser.map((row) => row._id), actor.organization);

  return {
    range: rangeInfo(range),
    quota: counters
      ? { available: true, monthlyLimit: quotas.orgMonthlyTokens, monthlyUsed: counters.orgMonthlyUsed, monthlyRemaining: Math.max(0, quotas.orgMonthlyTokens - counters.orgMonthlyUsed), resetsAt: counters.monthResetsAt }
      : { available: false, monthlyLimit: quotas.orgMonthlyTokens },
    userDailyLimit: quotas.userDailyTokens,
    totals: present(totals[0]),
    series: daily,
    byFeature: byFeature.map((row) => ({ feature: row._id, ...present(row) })),
    byModel: byModel.map((row) => ({ provider: row._id.provider, model: row._id.model, ...present(row) })),
    byUser: byUser.map((row) => ({ userId: idOf(row._id), name: names.get(idOf(row._id)) || 'Former member', ...present(row) })),
    errors: byError.map((row) => ({ code: row._id || 'UNKNOWN', requests: row.requests })),
    notes: NOTES,
    pricingVersion: pricingVersion(),
  };
}

/** Super-admin: platform-wide totals only. No organization names, ids, users or rows. */
async function getPlatformUsage({ query = {} } = {}) {
  const range = resolveRange(query, DEFAULT_TIME_ZONE);
  const match = { createdAt: { $gte: range.start, $lt: range.end } };
  const [totals, daily, active] = await Promise.all([
    run(AiUsageEvent, [{ $match: match }, { $group: { _id: null, ...metrics } }]),
    series(match, range),
    run(AiUsageEvent, [{ $match: match }, { $group: { _id: '$organization' } }, { $count: 'n' }]),
  ]);
  return { range: rangeInfo(range), activeOrganizations: active[0]?.n || 0, totals: present(totals[0]), series: daily, notes: NOTES, rateLimits: { perMinute: env.AI_RATE_LIMIT_PER_MINUTE, concurrent: env.AI_MAX_CONCURRENT_PER_USER } };
}

module.exports = { getMyUsage, getOrgUsage, getPlatformUsage };
