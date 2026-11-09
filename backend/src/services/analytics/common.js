const AppError = require('../../utils/app-error');
const { ANALYTICS_LIMITS } = require('../../constants/analytics.constants');
const User = require('../../models/User');

const MAX_TIME_MS = ANALYTICS_LIMITS.MAX_TIME_MS;
const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const fullName = (user) => (user && user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : 'Former member');
const percent = (part, whole, digits = 1) => (whole > 0 ? Number(((part / whole) * 100).toFixed(digits)) : null);

/** Every analytics aggregation is time-boxed. */
const run = (model, pipeline) => model.aggregate(pipeline).option({ maxTimeMS: MAX_TIME_MS });

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

/** id → display name for people in this organization. Anyone who has left shows as "Former member". */
async function personNames(ids, organization) {
  const unique = [...new Set(ids.map(idOf).filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique }, organization }).select('firstName lastName').lean();
  return new Map(users.map((user) => [idOf(user._id), fullName(user)]));
}

const table = (columns, rows, extra = {}) => ({ columns, rows: rows.slice(0, ANALYTICS_LIMITS.TABLE_ROWS_MAX), truncated: rows.length > ANALYTICS_LIMITS.TABLE_ROWS_MAX, ...extra });

const requireKind = (scope, kinds, message = 'Analytics are not available for your role') => {
  if (!kinds.includes(scope.kind)) throw new AppError(message, 403, 'FORBIDDEN');
};

const COMPLETION_NOTE = 'Completion trends use each task\'s recorded completion date. Tasks completed before completion dates were tracked have none, so they count in totals but not in completion trends or average completion time.';

module.exports = { COMPLETION_NOTE, MAX_TIME_MS, fullName, idOf, percent, personNames, requireKind, run, sum, table };
