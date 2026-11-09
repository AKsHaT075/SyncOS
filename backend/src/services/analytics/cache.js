const crypto = require('crypto');
const { ANALYTICS_LIMITS } = require('../../constants/analytics.constants');

/**
 * Tiny in-process TTL cache for analytics results. The key contains everything that can change a result:
 * organization, user, role, the hash of the resolved access scope (teams led, visible projects, …), the endpoint,
 * the filters, the date range and the timezone. A permission, role, team or project-membership change therefore
 * produces a different key — a previously cached result for the old scope can never be served. It is deliberately
 * per-process (a stale entry lives at most one TTL) and is bypassed under test unless a test opts in.
 */
const store = new Map();

const enabled = () => process.env.ANALYTICS_CACHE === 'on' || (process.env.NODE_ENV !== 'test' && process.env.ANALYTICS_CACHE !== 'off');

function cacheKey({ scope, endpoint, filters = {}, range }) {
  return crypto.createHash('sha1').update(JSON.stringify({
    o: String(scope.organization), u: String(scope.actor._id), r: scope.role, p: [...scope.permissions].sort(), s: scope.fingerprint,
    e: endpoint, f: filters, d: [range?.from, range?.to], z: scope.timeZone,
  })).digest('hex');
}

async function cached(parts, compute) {
  if (!enabled()) return compute();
  const key = cacheKey(parts);
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await compute();
  store.set(key, { value, expires: Date.now() + ANALYTICS_LIMITS.CACHE_TTL_MS });
  while (store.size > ANALYTICS_LIMITS.CACHE_MAX_ENTRIES) store.delete(store.keys().next().value);
  return value;
}

const clearAnalyticsCache = () => store.clear();

module.exports = { cacheKey, cached, clearAnalyticsCache };
