const AppError = require('../../../utils/app-error');
const { AI_TOOL_ERRORS: T } = require('../../../constants/ai.constants');
const User = require('../../../models/User');
const Project = require('../../../models/Project');
const { buildAiPeopleFilter } = require('../../../utils/aiAccess');
const { idString } = require('./projections');

/**
 * Shared plumbing for tools: cancellation checks, bounded queries, and name look-ups. A tool that follows these three rules
 * cannot outlive its request:
 *   1. call `ensureActive(signal)` before every query and after every await (an aborted signal throws AI_TOOL_ABORTED);
 *   2. give EVERY query `timed(query, maxTimeMs)` (a Mongo maxTimeMS), so the database stops work at the deadline;
 *   3. run queries through `guarded(...)`, which turns a database time-limit error into the fixed AI_TOOL_TIMEOUT.
 */

function ensureActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof AppError ? signal.reason : new AppError('The lookup was cancelled', 499, T.ABORTED);
}

const timed = (query, maxTimeMs) => (maxTimeMs ? query.maxTimeMS(maxTimeMs) : query);

const isTimeLimit = (error) => error?.code === 50 || /operation exceeded time limit/i.test(String(error?.message || ''));

/** Runs one database step: checks cancellation before and after, and maps the database's time-limit error to the fixed timeout error. */
async function guarded(signal, step) {
  ensureActive(signal);
  try {
    const value = await step();
    ensureActive(signal);
    return value;
  } catch (error) {
    if (isTimeLimit(error)) throw new AppError('The lookup took too long', 504, T.TIMEOUT);
    throw error;
  }
}

/** id -> display name for people the actor may see through AI (an inactive / blocked / foreign person is simply absent -> "Former member"). */
async function peopleNames(actor, ids, { signal, maxTimeMs } = {}) {
  const unique = [...new Set(ids.map(idString).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await guarded(signal, () => timed(User.find({ _id: { $in: unique }, ...buildAiPeopleFilter(actor) }).select('firstName lastName').lean(), maxTimeMs));
  return new Map(rows.map((row) => [idString(row._id), `${row.firstName || ''} ${row.lastName || ''}`.trim()]));
}

/** id -> project name, for projects ALREADY known to be visible (ids came out of an AI-filtered query). Organization-scoped anyway. */
async function projectNames(actor, ids, { signal, maxTimeMs } = {}) {
  const unique = [...new Set(ids.map(idString).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await guarded(signal, () => timed(Project.find({ _id: { $in: unique }, organization: actor.organization }).select('name').lean(), maxTimeMs));
  return new Map(rows.map((row) => [idString(row._id), row.name]));
}

/** Escapes a model-supplied string so it can only ever match LITERALLY inside a regular expression. Callers also bound its length. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Collapses whitespace and trims a model-supplied reference / name (length is bounded by the argument schema). */
const normalizeRef = (value) => String(value).replace(/\s+/g, ' ').trim();

const HEX24 = /^[a-f0-9]{24}$/i;

module.exports = { HEX24, ensureActive, escapeRegex, guarded, isTimeLimit, normalizeRef, peopleNames, projectNames, timed };
