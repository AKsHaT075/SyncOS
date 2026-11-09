const { TASK_STATUS } = require('./task.constants');
const { PROJECT_STATUS } = require('./project.constants');

/** Hard limits that keep every analytics query bounded. */
const ANALYTICS_LIMITS = Object.freeze({
  MAX_RANGE_DAYS: 366,
  DAILY_BUCKET_MAX_DAYS: 92, // longer ranges are bucketed by month
  DEFAULT_RANGE_DAYS: 30,
  MAX_PEOPLE: 2000,
  MAX_TEAMS: 200,
  MAX_PROJECTS: 5000,
  TOP_N: 10,
  TABLE_ROWS_MAX: 5000, // rows in a detail report / CSV export
  PAGE_MAX: 100,
  MAX_TIME_MS: 15000,
  UPCOMING_DAYS: 14,
  CACHE_TTL_MS: 60 * 1000,
  CACHE_MAX_ENTRIES: 300,
});

/** A task still needs work in these states. Completed and Cancelled are finished. */
const OPEN_TASK_STATUSES = Object.freeze([TASK_STATUS.TODO, TASK_STATUS.IN_PROGRESS, TASK_STATUS.IN_REVIEW]);
/** A project is "running" (can be overdue) in these states. */
const RUNNING_PROJECT_STATUSES = Object.freeze([PROJECT_STATUS.PLANNING, PROJECT_STATUS.ACTIVE, PROJECT_STATUS.ON_HOLD]);

/**
 * What kind of view an actor gets. Decided once per request by `resolveScope`.
 *   organization  org-admin / admin: everything in the organization
 *   aggregate     hr: organization-wide COUNTS only (never titles, project names or task content)
 *   team          manager: the teams they lead, restricted to what they can already see
 *   self          employee: only their own data
 *   none          guest / super-admin (platform analytics is a separate surface)
 */
const SCOPE_KIND = Object.freeze({ ORGANIZATION: 'organization', AGGREGATE: 'aggregate', TEAM: 'team', SELF: 'self', NONE: 'none' });

const REPORT_TYPES = Object.freeze(['tasks', 'projects', 'people', 'teams', 'meetings', 'assets']);

module.exports = { ANALYTICS_LIMITS, OPEN_TASK_STATUSES, REPORT_TYPES, RUNNING_PROJECT_STATUSES, SCOPE_KIND };
