const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { OPEN_TASK_STATUSES } = require('../../../constants/analytics.constants');
const { TASK_STATUS } = require('../../../constants/task.constants');
const Task = require('../../../models/Task');
const { buildAiTaskFilter, canAiViewTask } = require('../../../utils/aiAccess');
const { dueWindow } = require('../../../utils/aiDateRanges');
const { resolveTimeZone } = require('../../calendar.service');
const { cleanText, fitRows, idString, projectTask } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { outcomeShape, projectRefSchema, refArgument, resolveProject } = require('./projectLookup');
const { fetchTaskPage } = require('./taskPaging');
const { ensureActive, guarded, peopleNames, timed } = require('./toolSupport');

/**
 * list_project_tasks: tasks of ONE project the user can see.
 *
 * The project is resolved through AI project visibility; the tasks are then selected by buildAiTaskFilter (private tasks only for
 * assignees, approvers and the project's owner / Manager-role members, NO administrator bypass), and EVERY returned row is checked
 * again with the pure predicate canAiViewTask. The total shown and the rows come from that same filter, so a count never includes a
 * task the user cannot see. status / due use list_my_tasks's semantics (open = Todo / In Progress / In Review; overdue = open and
 * strictly before today; this_week = Monday-Sunday; all dates computed by Node in the user's timezone).
 */

const STATUSES = [...Object.values(TASK_STATUS), 'open', 'all'];
const DUE = ['overdue', 'today', 'next_7_days', 'this_week', 'none'];
const ASSIGNEES = ['me', 'any'];
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
const SELECT = 'title status priority dueDate project assignees approvers visibility organization archived deletedAt';

const argumentsSchema = z.object({
  project: refArgument,
  status: z.enum(STATUSES).optional(),
  due: z.enum(DUE).optional(),
  assignee: z.enum(ASSIGNEES).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
}).strict();

const resultSchema = z.object({
  ...outcomeShape,
  project: projectRefSchema.nullable(),
  data: z.array(AI_SCHEMAS.task).max(MAX_LIMIT),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
  asOf: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(64) }).strict(),
  filters: z.object({ status: z.string().max(20), due: z.string().max(20).nullable(), assignee: z.enum(ASSIGNEES) }).strict().nullable(),
}).strict();

function statusesFor(status, due) {
  const base = status === 'all' ? Object.values(TASK_STATUS) : status === 'open' ? OPEN_TASK_STATUSES : [status];
  return due === 'overdue' ? base.filter((s) => OPEN_TASK_STATUSES.includes(s)) : base; // overdue only ever means an open task
}

function createListProjectTasksTool({ now = () => Date.now() } = {}) {
  return {
    name: 'list_project_tasks',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Searching project tasks...',
    description: 'Lists tasks of one project the signed-in user can see, by project id or name, with title, status, priority, due date, whether it is overdue and assignees. Filter by status ("open" by default, or a status, or "all"), due (overdue, today, next_7_days, this_week, none) and assignee ("any" by default, or "me" for only the user\'s own tasks). Read-only; only tasks the user is allowed to see are listed or counted. If the project name matches several projects it returns the candidates instead of choosing.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: ['status', 'due', 'assignee', 'limit'],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const nowMs = now();
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor));
      const { today } = dueWindow({ due: 'today', nowMs, timeZone });
      const asOf = { date: today, timeZone };
      const limit = input.limit || DEFAULT_LIMIT;
      const status = input.status || 'open';
      const assignee = input.assignee || 'any';
      const filters = { status, due: input.due || null, assignee };

      const resolved = await resolveProject(actor, input.project, { signal, maxTimeMs });
      ensureActive(signal);
      if (resolved.outcome !== 'found') {
        return { outcome: resolved.outcome, matchedBy: null, candidates: resolved.candidates, project: null, data: [], summary: { count: 0, total: 0, truncated: false, complete: true }, asOf, filters: null };
      }
      const { project, scope } = resolved;
      const projectRef = { id: idString(project._id), name: cleanText(project.name, 160) };
      const base = { outcome: 'found', matchedBy: resolved.matchedBy, candidates: [], project: projectRef, asOf, filters };
      const empty = { ...base, data: [], summary: { count: 0, total: 0, truncated: false, complete: true } };

      const statuses = statusesFor(status, input.due);
      if (statuses.length === 0) return empty;

      const and = [buildAiTaskFilter(actor, scope), { project: project._id }, { status: { $in: statuses } }];
      if (assignee === 'me') and.push({ assignees: actor._id }); // the authenticated user, never a supplied id
      if (input.due) and.push({ dueDate: dueWindow({ due: input.due, nowMs, timeZone }).filter });
      const filter = { $and: and };

      const total = await guarded(signal, () => timed(Task.countDocuments(filter), maxTimeMs));
      if (total === 0) return empty;

      const page = await fetchTaskPage({ and, limit, due: input.due, select: SELECT, signal, maxTimeMs });
      // Row-level check, independent of the query: a task is only ever returned if the pure predicate allows it too.
      const visible = page.rows.filter((task) => canAiViewTask(actor, project, task));
      const names = await peopleNames(actor, visible.flatMap((t) => t.assignees || []), { signal, maxTimeMs });
      const projected = visible.map((task) => projectTask(task, { names, project, today }));
      const fit = fitRows(projected, { reserveBytes: 800 });
      return { ...base, data: fit.rows, summary: { count: fit.rows.length, total, truncated: page.more || fit.truncated, complete: true } };
    },
  };
}

module.exports = { argumentsSchema, createListProjectTasksTool, resultSchema };
