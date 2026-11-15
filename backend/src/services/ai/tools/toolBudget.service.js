const crypto = require('crypto');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const { AI_TOOL_ERRORS: T } = require('../../../constants/ai.constants');
const { withRedis } = require('../aiLimits.service');

/**
 * The per-request TOOL BUDGET. Node opens one when - and only when - it admits a request that may use tools; a tool
 * callback with no open budget is refused, so no model round and no tool run can ever happen unmetered or unbounded.
 *
 * Everything here is decided in Redis, atomically, by one script, so two simultaneous callbacks cannot both slip past a limit:
 *   - calls         total executions
 *   - inflight      executions running now
 *   - ms            time spent in tools (a call may not start once the total is spent)
 *   - duplicates    the same tool with the same canonical arguments is run at most once per request
 * The budget key carries the organization in a hash tag (like the quota keys) and expires with the request ceiling, so a crashed
 * request cannot leave one behind.
 */

const budgetKey = (orgId, requestKey) => `${env.AI_REDIS_PREFIX}:tool:{${orgId}}:${requestKey}`;
const TTL_SECONDS = () => Math.ceil(env.AI_REQUEST_CEILING_MS / 1000) + 60;

const OPEN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'calls', 0, 'inflight', 0, 'ms', 0, 'failures', 0, 'maxCalls', ARGV[1], 'maxConcurrent', ARGV[2], 'maxMs', ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

// returns 1 ok | -1 no budget | -2 calls spent | -3 time spent | -4 too many running | -5 duplicate
const ACQUIRE_SCRIPT = `
local k = KEYS[1]
if redis.call('EXISTS', k) == 0 then return -1 end
local v = redis.call('HMGET', k, 'calls', 'inflight', 'ms', 'maxCalls', 'maxConcurrent', 'maxMs')
if tonumber(v[1]) >= tonumber(v[4]) then return -2 end
if tonumber(v[3]) >= tonumber(v[6]) then return -3 end
if tonumber(v[2]) >= tonumber(v[5]) then return -4 end
if redis.call('HEXISTS', k, 'h:' .. ARGV[1]) == 1 then return -5 end
redis.call('HSET', k, 'h:' .. ARGV[1], 1)
redis.call('HINCRBY', k, 'calls', 1)
redis.call('HINCRBY', k, 'inflight', 1)
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[1], 'inflight', -1)
redis.call('HINCRBY', KEYS[1], 'ms', tonumber(ARGV[1]))
if ARGV[2] == '1' then redis.call('HINCRBY', KEYS[1], 'failures', 1) end
return 1
`;

/** Stable fingerprint of a call: tool name + arguments with keys sorted, so the same call in a different key order is the same call. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const callHash = (name, input) => crypto.createHash('sha256').update(`${name}\n${canonicalize(input)}`).digest('hex').slice(0, 32);

/** Opens the budget for a request. Idempotent. Called by the AI pipeline when it admits a tool-capable request. */
async function openBudget({ orgId, requestKey, limits }) {
  await withRedis((client) =>
    client.eval(OPEN_SCRIPT, { keys: [budgetKey(orgId, requestKey)], arguments: [String(limits.maxCalls), String(limits.maxConcurrent), String(limits.totalMs), String(TTL_SECONDS())] }),
  );
}

const REFUSALS = {
  [-1]: () => new AppError('Tool not found', 404, T.NOT_FOUND), // no budget: indistinguishable from "no such tool"
  [-2]: () => new AppError('This request has used all of its lookups', 429, T.BUDGET),
  [-3]: () => new AppError('This request has used all of its lookup time', 429, T.BUDGET),
  [-4]: () => new AppError('Too many lookups are running for this request', 429, T.CONCURRENCY),
  [-5]: () => new AppError('That lookup was already made for this request', 409, T.DUPLICATE),
};

/** Reserves one execution slot or throws the matching refusal. Returns the call hash. */
async function acquire({ orgId, requestKey, name, input }) {
  const hash = callHash(name, input);
  const code = await withRedis((client) => client.eval(ACQUIRE_SCRIPT, { keys: [budgetKey(orgId, requestKey)], arguments: [hash] }));
  if (code !== 1) throw (REFUSALS[code] || REFUSALS[-1])();
  return hash;
}

/** Gives the slot back and records the time spent. Never throws: bookkeeping must not replace the call's outcome. */
async function release({ orgId, requestKey, ms, failed }) {
  try {
    await withRedis((client) => client.eval(RELEASE_SCRIPT, { keys: [budgetKey(orgId, requestKey)], arguments: [String(Math.max(0, Math.round(ms))), failed ? '1' : '0'] }));
  } catch {
    /* self-expiring */
  }
}

/** Milliseconds of tool time this request may still spend (0 when spent or when there is no budget). */
async function remainingMs({ orgId, requestKey }) {
  try {
    const [spent, max] = await withRedis((client) => client.hmGet(budgetKey(orgId, requestKey), ['ms', 'maxMs']));
    if (spent === null || max === null) return 0;
    return Math.max(0, Number(max) - Number(spent));
  } catch {
    return 0;
  }
}

/** Reads the request's tool counters and removes the budget (called once, when the request is finalized). Never throws. */
async function closeBudget({ orgId, requestKey }) {
  try {
    return await withRedis(async (client) => {
      const key = budgetKey(orgId, requestKey);
      const [calls, ms, failures] = await client.hmGet(key, ['calls', 'ms', 'failures']);
      await client.del(key);
      return { toolCalls: Number(calls || 0), toolMs: Number(ms || 0), toolFailures: Number(failures || 0) };
    });
  } catch {
    return { toolCalls: 0, toolMs: 0, toolFailures: 0 };
  }
}

module.exports = { acquire, callHash, canonicalize, closeBudget, openBudget, release, remainingMs };
