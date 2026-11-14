const env = require('../../config/env');
const AppError = require('../../utils/app-error');
const { createRedisClient } = require('../../config/redis');
const { AI_LIMIT_CODES: L } = require('../../constants/ai.constants');
const { startOfLocalDay } = require('../../utils/analyticsRange');
const { addDaysToDateString, localDateOf } = require('../../utils/timezone');

/**
 * Per-user rate limiting, concurrency limiting and token quotas, all in Redis.
 *
 * Atomicity: every decision is ONE Lua script, so there is no check-then-increment
 * window. Two concurrent requests can never both pass the last remaining budget.
 *
 * Quota model (tokens = input + output):
 *   - A request RESERVES a worst-case amount (estimated input + output cap) up
 *     front, against BOTH the user's daily counter and the organization's
 *     monthly counter in a single script. If either would overflow, neither is
 *     touched.
 *   - When the request ends it SETTLES: the reservation is replaced by the
 *     actual charge. Settlement is idempotent (the reservation record is
 *     deleted atomically) so a retried/duplicated settle can never double
 *     charge or double refund.
 *   - Counters live in the same key as the reservation, so an in-flight
 *     request already counts against the budget. Quotas are therefore tight
 *     under concurrency, and only exceeded by at most one request's
 *     under-estimate (a request whose real usage beats its reservation).
 *   - Fail closed: any Redis problem raises AI_LIMITS_UNAVAILABLE (503). AI is
 *     refused, never run unmetered.
 *   - A crash between reserve and settle leaves the reservation counted until
 *     the window rolls over (over-counting, never under-counting).
 *
 * Keys carry the organization in a hash tag so a clustered Redis keeps one
 * org's keys in one slot (the scripts touch several of them).
 *
 * Windows are calendar days / months in the ORGANIZATION's timezone
 * (org setting, else IST), matching how analytics buckets time.
 */

const p = () => env.AI_REDIS_PREFIX;
const tag = (orgId) => `{${orgId}}`;
const keys = {
  userDay: (orgId, userId, day) => `${p()}:q:${tag(orgId)}:u:${userId}:${day}`,
  orgMonth: (orgId, month) => `${p()}:q:${tag(orgId)}:o:${month}`,
  reservation: (orgId, requestKey) => `${p()}:q:${tag(orgId)}:r:${requestKey}`,
  rateWindow: (orgId, userId, minute) => `${p()}:rl:${tag(orgId)}:m:${userId}:${minute}`,
  inflight: (orgId, userId) => `${p()}:rl:${tag(orgId)}:c:${userId}`,
  outbox: () => `${p()}:usage-outbox`,
};

const RESERVE_SCRIPT = `
local u = tonumber(redis.call('GET', KEYS[1]) or '0')
local o = tonumber(redis.call('GET', KEYS[2]) or '0')
local amt = tonumber(ARGV[1])
if redis.call('EXISTS', KEYS[3]) == 1 then return {2, u, o} end
if u + amt > tonumber(ARGV[2]) then return {-1, u, o} end
if o + amt > tonumber(ARGV[3]) then return {-2, u, o} end
u = redis.call('INCRBY', KEYS[1], amt)
o = redis.call('INCRBY', KEYS[2], amt)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
redis.call('SET', KEYS[3], amt, 'EX', tonumber(ARGV[6]))
return {1, u, o}
`;

// Replaces the reservation with the actual charge. No-op if the reservation is gone (already settled / expired).
const SETTLE_SCRIPT = `
local amt = redis.call('GET', KEYS[1])
if not amt then return {0, 0} end
redis.call('DEL', KEYS[1])
local delta = tonumber(ARGV[1]) - tonumber(amt)
if delta ~= 0 then
  for i = 2, 3 do
    local cur = redis.call('GET', KEYS[i])
    if cur then
      local nxt = tonumber(cur) + delta
      if nxt < 0 then nxt = 0 end
      redis.call('SET', KEYS[i], nxt, 'KEEPTTL')
    end
  end
end
return {1, delta}
`;

// Concurrency (ZSET of in-flight request keys, self-expiring) + fixed one-minute request window, checked together.
const ADMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local inflight = redis.call('ZCARD', KEYS[2])
if inflight >= tonumber(ARGV[4]) then return {-2, inflight} end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[2]) then return {-1, count} end
redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[5]), ARGV[6])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]) + 60000)
return {1, count + 1}
`;

const unavailable = () => new AppError('AI usage limits are temporarily unavailable. Please try again shortly', 503, L.LIMITS_UNAVAILABLE);

/** Runs a Redis operation; any failure (down, timeout, script error) becomes the fail-closed error. */
async function withRedis(operation) {
  const client = createRedisClient();
  if (!client.isOpen) throw unavailable();
  try {
    return await operation(client);
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error('[ai-limits] Redis error:', error.message);
    throw unavailable();
  }
}

function nextMonthFirst(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The day and month windows that apply to this instant in this timezone. */
function windows({ orgId, userId, timeZone, now = Date.now() }) {
  const today = localDateOf(now, timeZone);
  const month = today.slice(0, 7);
  const dayResetsAt = startOfLocalDay(addDaysToDateString(today, 1), timeZone);
  const monthResetsAt = startOfLocalDay(nextMonthFirst(month), timeZone);
  const secondsUntil = (date) => Math.max(1, Math.ceil((date.getTime() - now) / 1000));
  return {
    day: today,
    month,
    userKey: keys.userDay(orgId, userId, today),
    orgKey: keys.orgMonth(orgId, month),
    dayResetsAt,
    monthResetsAt,
    // Generous expiry beyond the reset so a settle after rollover still finds its counters.
    userTtl: secondsUntil(dayResetsAt) + 2 * 86400,
    orgTtl: secondsUntil(monthResetsAt) + 2 * 86400,
  };
}

/** Rate limit + concurrency. Throws a 429 (or the fail-closed 503); consumes nothing when it refuses. */
async function admit({ orgId, userId, requestKey, now = Date.now() }) {
  const minute = Math.floor(now / 60000);
  const result = await withRedis((client) =>
    client.eval(ADMIT_SCRIPT, {
      keys: [keys.rateWindow(orgId, userId, minute), keys.inflight(orgId, userId)],
      arguments: [String(now), String(env.AI_RATE_LIMIT_PER_MINUTE), '120', String(env.AI_MAX_CONCURRENT_PER_USER), String(env.AI_REQUEST_CEILING_MS + 30000), requestKey],
    }),
  );
  if (result[0] === 1) return;
  if (result[0] === -2) {
    throw new AppError('You have too many AI requests running. Wait for one to finish', 429, L.TOO_MANY_CONCURRENT, { limit: env.AI_MAX_CONCURRENT_PER_USER });
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(((minute + 1) * 60000 - now) / 1000));
  throw new AppError('You are sending AI requests too quickly. Please wait a moment', 429, L.RATE_LIMITED, { retryAfterSeconds, limitPerMinute: env.AI_RATE_LIMIT_PER_MINUTE });
}

/** Best effort; the in-flight entry also expires on its own. */
async function release({ orgId, userId, requestKey }) {
  try {
    await withRedis((client) => client.zRem(keys.inflight(orgId, userId), requestKey));
  } catch {
    /* self-expiring */
  }
}

/**
 * Atomically reserves `amount` tokens against the user's daily and the org's monthly budget.
 * Returns the context needed to settle. Throws a 429 quota error (nothing reserved) or the fail-closed 503.
 */
async function reserve({ orgId, userId, requestKey, amount, quotas, timeZone, now = Date.now() }) {
  if (amount > Math.min(quotas.userDailyTokens, quotas.orgMonthlyTokens)) {
    throw new AppError('This request is larger than the AI quota allows', 413, L.REQUEST_TOO_LARGE, { requestedTokens: amount });
  }
  const w = windows({ orgId, userId, timeZone, now });
  const reservationKey = keys.reservation(orgId, requestKey);
  const result = await withRedis((client) =>
    client.eval(RESERVE_SCRIPT, {
      keys: [w.userKey, w.orgKey, reservationKey],
      arguments: [String(amount), String(quotas.userDailyTokens), String(quotas.orgMonthlyTokens), String(w.userTtl), String(w.orgTtl), String(env.AI_RESERVATION_TTL_SECONDS)],
    }),
  );
  if (result[0] === -1) {
    throw new AppError('Your daily AI quota has been used. It resets tomorrow', 429, L.QUOTA_USER_DAILY, { resetsAt: w.dayResetsAt });
  }
  if (result[0] === -2) {
    throw new AppError('Your organization\'s monthly AI quota has been used', 429, L.QUOTA_ORG_MONTHLY, { resetsAt: w.monthResetsAt });
  }
  return { reservationKey, userKey: w.userKey, orgKey: w.orgKey, amount };
}

/** Replaces the reservation with the real charge (>= 0). Idempotent. Returns false if there was nothing to settle. */
async function settle({ reservation, actual }) {
  const charge = Math.max(0, Math.round(actual));
  const result = await withRedis((client) =>
    client.eval(SETTLE_SCRIPT, { keys: [reservation.reservationKey, reservation.userKey, reservation.orgKey], arguments: [String(charge)] }),
  );
  return result[0] === 1;
}

/** Current counters for display. Returns null (not zero) when Redis cannot be read. */
async function readCounters({ orgId, userId, timeZone, now = Date.now() }) {
  const w = windows({ orgId, userId, timeZone, now });
  try {
    const [user, org] = await withRedis((client) => client.mGet([w.userKey, w.orgKey]));
    return { userDailyUsed: Number(user || 0), orgMonthlyUsed: Number(org || 0), dayResetsAt: w.dayResetsAt, monthResetsAt: w.monthResetsAt };
  } catch {
    return null;
  }
}

/**
 * Is this request currently in flight? Backs the callback gate: a callback token is honoured only
 * while the request that minted it is still running. Redis trouble => false (fail closed).
 */
async function isInFlight({ orgId, userId, requestKey, now = Date.now() }) {
  try {
    const score = await withRedis((client) => client.zScore(keys.inflight(orgId, userId), requestKey));
    return score !== null && score !== undefined && Number(score) > now;
  } catch {
    return false;
  }
}

module.exports = { admit, isInFlight, keys, readCounters, release, reserve, settle, windows, withRedis };
