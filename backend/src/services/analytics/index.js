const AppError = require('../../utils/app-error');
const { ANALYTICS_LIMITS, REPORT_TYPES, SCOPE_KIND } = require('../../constants/analytics.constants');
const { resolveRange } = require('../../utils/analyticsRange');
const { csvCell } = require('../assetReports.service');
const { cached, clearAnalyticsCache } = require('./cache');
const { computeAssets } = require('./assets');
const { computeMeetings } = require('./meetings');
const { computeOverview, withoutTable } = require('./overview');
const { computePeople } = require('./people');
const { computePersonal } = require('./personal');
const { computePlatform } = require('./platform');
const { computeProjects } = require('./projects');
const { resolveFilters, resolveScope } = require('./scope');
const { computeTasks } = require('./tasks');
const { computeTeams } = require('./teams');

const DOMAINS = {
  overview: computeOverview,
  tasks: computeTasks,
  projects: computeProjects,
  people: computePeople,
  teams: computeTeams,
  meetings: computeMeetings,
  assets: computeAssets,
  me: (scope, range) => computePersonal(scope, range),
};

const publicFilters = (filters) => ({ teamId: filters.teamId, userId: filters.userId, projectId: filters.projectId });

/** One entry point: resolve scope → validate filters against it → compute (cached) → wrap. */
async function loadDomain(actor, type, query = {}) {
  const compute = DOMAINS[type];
  if (!compute) throw new AppError('Unknown analytics view', 404, 'NOT_FOUND');
  if (type === 'me' && !actor.organization) throw new AppError('Analytics are not available for your role', 403, 'FORBIDDEN');

  const scope = await resolveScope(actor, { timezone: query.timezone });
  const range = resolveRange(query, scope.timeZone);
  const filters = type === 'me' ? { personIds: scope.personIds } : await resolveFilters(scope, query);
  const data = await cached(
    { scope, endpoint: type, filters: { ...publicFilters(filters), people: filters.personIds && scope.personIds === null ? filters.personIds.map(String) : undefined }, range },
    () => compute(scope, range, filters),
  );
  return { scope, range, filters, data };
}

const envelope = ({ scope, range, filters }) => ({
  scope: { kind: scope.kind, details: scope.details, truncated: scope.truncated },
  range: { from: range.from, to: range.to, days: range.days, granularity: range.granularity, timeZone: range.timeZone },
  filters: publicFilters(filters),
});

async function getAnalytics({ actor, type, query }) {
  const loaded = await loadDomain(actor, type, query);
  return { ...envelope(loaded), ...withoutTable(loaded.data) };
}

async function getPlatformAnalytics({ actor, query }) {
  return computePlatform(actor, query);
}

// ---- detailed reports (same calculations as the overview) ---------------------------------------------

async function loadReport(actor, type, query) {
  if (!REPORT_TYPES.includes(type)) throw new AppError('Unknown report', 404, 'NOT_FOUND');
  const loaded = await loadDomain(actor, type, query);
  if (!loaded.data.table) throw new AppError('A detailed report is not available for your role', 403, 'FORBIDDEN');
  return loaded;
}

async function getReport({ actor, type, query }) {
  const loaded = await loadReport(actor, type, query);
  const { table } = loaded.data;
  const page = query.page || 1;
  const limit = Math.min(query.limit || 25, ANALYTICS_LIMITS.PAGE_MAX);
  return {
    ...envelope(loaded),
    type,
    columns: table.columns,
    rows: table.rows.slice((page - 1) * limit, page * limit),
    truncated: Boolean(table.truncated),
    pagination: { page, limit, total: table.rows.length, pages: Math.max(1, Math.ceil(table.rows.length / limit)) },
    notes: loaded.data.notes || [],
  };
}

async function exportReport({ actor, type, query }) {
  const loaded = await loadReport(actor, type, query);
  const { columns, rows } = loaded.data.table;
  const lines = [columns.map((column) => csvCell(column.label)).join(',')];
  rows.forEach((row) => lines.push(columns.map((column) => csvCell(row[column.key])).join(',')));
  const { from, to } = loaded.range;
  return { filename: `${type}-report-${from}_to_${to}.csv`, csv: lines.join('\r\n') };
}


module.exports = { DOMAINS, SCOPE_KIND, clearAnalyticsCache, exportReport, getAnalytics, getPlatformAnalytics, getReport };
