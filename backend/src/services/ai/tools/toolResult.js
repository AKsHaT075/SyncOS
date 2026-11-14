const AppError = require('../../../utils/app-error');
const { AI_TOOL_ERRORS: T } = require('../../../constants/ai.constants');

/**
 * What a tool may hand back, enforced AFTER the tool's own projection and BEFORE anything leaves Node.
 *
 * The tool's explicit allowlist (a strict zod `resultSchema`) is the primary control: any field it does not name is a failure,
 * not something that is silently dropped. On top of that every result must be plain JSON data within hard limits. A violation
 * is REJECTED (fail closed), never truncated: a tool that returns too much has a bug, and the gate must surface it rather than
 * quietly pass a partial record on.
 *
 * Never allowed, whatever a schema says: Mongo documents / ObjectIds / Dates / other class instances, undefined, non-finite
 * numbers, operator-like or dotted keys, and a small set of obviously sensitive key names (defence in depth; the allowlist is
 * what actually protects fields).
 */

const FORBIDDEN_KEYS = new Set(['_id', '__v', 'passwordhash', 'password', 'token', 'accesstoken', 'refreshtoken', 'secret', 'email', 'livekitroomname', 'keyreference', 'apikey']);
const tooLarge = () => new AppError('Tool result is too large', 502, T.RESULT_TOO_LARGE);
const invalid = () => new AppError('Tool result is not valid', 502, T.RESULT_INVALID);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Walks the value once, checking type, depth, string length, array length and keys. Returns the number of records (array items) seen. */
function inspect(value, limits, depth = 1, stats = { records: 0 }) {
  if (depth > limits.maxDepth) throw tooLarge();
  if (value === null || typeof value === 'boolean') return stats;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return stats;
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringChars) throw tooLarge();
    return stats;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxRecords) throw tooLarge();
    stats.records += value.length;
    for (const item of value) inspect(item, limits, depth + 1, stats);
    return stats;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key.toLowerCase())) throw invalid();
      if (item === undefined) throw invalid();
      inspect(item, limits, depth + 1, stats);
    }
    return stats;
  }
  throw invalid(); // Date, ObjectId, mongoose document, Buffer, function, class instance, undefined, bigint, symbol ...
}

/**
 * Validates and measures a tool's raw result. Returns { result, meta: { records, bytes } } where `result` is a fresh deep copy
 * (parsed from its own serialization), so nothing by reference from the tool survives.
 */
function projectResult(tool, raw, limits) {
  const parsed = tool.resultSchema.safeParse(raw === undefined ? null : raw);
  if (!parsed.success) throw invalid(); // field names are NOT reported: they describe what the data source holds
  const stats = inspect(parsed.data, limits);
  const serialized = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > limits.maxResultBytes) throw tooLarge();
  return { result: JSON.parse(serialized), meta: { records: stats.records, bytes } };
}

module.exports = { inspect, projectResult };
