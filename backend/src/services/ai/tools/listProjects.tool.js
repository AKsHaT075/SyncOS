const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { PROJECT_STATUS } = require('../../../constants/project.constants');
const { RUNNING_PROJECT_STATUSES } = require('../../../constants/analytics.constants');
const Project = require('../../../models/Project');
const { dueWindow } = require('../../../utils/aiDateRanges');
const { resolveTimeZone } = require('../../calendar.service');
const aiScope = require('./aiScope');
const { fitRows, projectProject } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { openCountsByProject } = require('./taskCounts');
const { ensureActive, escapeRegex, guarded, normalizeRef, peopleNames, timed } = require('./toolSupport');

/**
 * list_projects: the projects the user can see through AI (owner or member of any; Organization-visible; Team-visible for their team
 * and admins; PRIVATE only for owner and members, administrators included; archived and deleted never).
 *
 * Counts (openTasks / overdueTasks) come from the same AI task-visibility filter as list_project_tasks, so they never include a task
 * the user could not see. Sorting is deterministic: a stable tie-breaker (name, then id) follows every sort key.
 * Coverage is reported honestly: `complete` is false if the 2,000-visible-project cap was reached.
 */

const STATUSES = [PROJECT_STATUS.PLANNING, PROJECT_STATUS.ACTIVE, PROJECT_STATUS.ON_HOLD, PROJECT_STATUS.COMPLETED, 'all'];
const SORTS = ['due', 'open_tasks', 'overdue_tasks'];
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
const SELECT = 'name status priority type dueDate startDate owner members';

const argumentsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  overdue: z.boolean().optional(),
  name_contains: z.string().trim().min(1).max(60).optional(),
  sort: z.enum(SORTS).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
}).strict();

const resultSchema = z.object({
  data: z.array(AI_SCHEMAS.project).max(MAX_LIMIT),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
  asOf: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(64) }).strict(),
  filters: z.object({ status: z.string().max(20), overdue: z.boolean().nullable(), nameFilter: z.boolean(), sort: z.enum(SORTS) }).strict(),
}).strict();

const nameKey = (project) => String(project.name || '').toLowerCase();
const dueKey = (project) => (project.dueDate ? project.dueDate.getTime() : Number.POSITIVE_INFINITY); // no due date sorts last
const byStable = (a, b) => (nameKey(a) < nameKey(b) ? -1 : nameKey(a) > nameKey(b) ? 1 : String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0);

function comparator(sort, counts) {
  const open = (p) => counts.get(String(p._id))?.open || 0;
  const late = (p) => counts.get(String(p._id))?.overdue || 0;
  if (sort === 'open_tasks') return (a, b) => open(b) - open(a) || dueKey(a) - dueKey(b) || byStable(a, b);
  if (sort === 'overdue_tasks') return (a, b) => late(b) - late(a) || open(b) - open(a) || dueKey(a) - dueKey(b) || byStable(a, b);
  return (a, b) => dueKey(a) - dueKey(b) || byStable(a, b);
}

function createListProjectsTool({ now = () => Date.now() } = {}) {
  return {
    name: 'list_projects',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Looking up projects...',
    description: 'Lists the projects the signed-in user can see, with status, priority, type, owner, start and due dates, whether the project is past its due date, member count and the number of open and overdue tasks they can see in it. Filter by status ("all" by default), overdue (true = past due date), or name_contains (matched literally); sort by due (default), open_tasks or overdue_tasks. Read-only; private projects appear only to their owner and members.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: ['status', 'overdue', 'sort', 'limit'],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const nowMs = now();
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor));
      const { today } = dueWindow({ due: 'today', nowMs, timeZone });
      const todayUtc = new Date(`${today}T00:00:00.000Z`);
      const limit = input.limit || DEFAULT_LIMIT;
      const sort = input.sort || 'due';
      const status = input.status || 'all';
      const filters = { status, overdue: input.overdue ?? null, nameFilter: Boolean(input.name_contains), sort };
      const asOf = { date: today, timeZone };

      const scope = await aiScope.resolveAiScope(actor, { maxTimeMs });
      ensureActive(signal);

      const and = [{ _id: { $in: scope.visibleProjectIds } }];
      if (status !== 'all') and.push({ status });
      if (input.overdue === true) and.push({ status: { $in: RUNNING_PROJECT_STATUSES }, dueDate: { $ne: null, $lt: todayUtc } });
      if (input.overdue === false) and.push({ $nor: [{ status: { $in: RUNNING_PROJECT_STATUSES }, dueDate: { $ne: null, $lt: todayUtc } }] });
      if (input.name_contains) and.push({ name: { $regex: escapeRegex(normalizeRef(input.name_contains)), $options: 'i' } }); // literal match only

      const projects = await guarded(signal, () => timed(Project.find({ $and: and }).select(SELECT).lean(), maxTimeMs));
      const complete = !scope.truncated;
      const empty = { data: [], summary: { count: 0, total: 0, truncated: false, complete }, asOf, filters };
      if (projects.length === 0) return empty;

      // Counts are needed for every candidate only when they decide the ORDER; otherwise just for the page that is shown.
      let counts = new Map();
      if (sort !== 'due') counts = await openCountsByProject(actor, scope, projects.map((p) => p._id), todayUtc, { signal, maxTimeMs });
      projects.sort(comparator(sort, counts));
      const page = projects.slice(0, limit);
      if (sort === 'due') counts = await openCountsByProject(actor, scope, page.map((p) => p._id), todayUtc, { signal, maxTimeMs });
      ensureActive(signal);

      const names = await peopleNames(actor, page.map((p) => p.owner), { signal, maxTimeMs });
      const rows = page.map((p) => projectProject(p, { names, today, counts: counts.get(String(p._id)) || { open: 0, overdue: 0 } }));
      const fit = fitRows(rows, { reserveBytes: 700 });
      return { data: fit.rows, summary: { count: fit.rows.length, total: projects.length, truncated: projects.length > fit.rows.length, complete }, asOf, filters };
    },
  };
}

module.exports = { argumentsSchema, createListProjectsTool, resultSchema, RUNNING_PROJECT_STATUSES };
