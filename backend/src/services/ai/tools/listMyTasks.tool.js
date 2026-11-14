const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { OPEN_TASK_STATUSES } = require('../../../constants/analytics.constants');
const { TASK_STATUS } = require('../../../constants/task.constants');
const Task = require('../../../models/Task');
const { buildAiTaskFilter } = require('../../../utils/aiAccess');
const { dueWindow } = require('../../../utils/aiDateRanges');
const { resolveTimeZone } = require('../../calendar.service');
const aiScope = require('./aiScope');
const { fitRows, projectTask } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { ensureActive, guarded, peopleNames, projectNames, timed } = require('./toolSupport');

/**
 * list_my_tasks: the signed-in user's own tasks.
 *
 * Authorization path (nothing here decides access by itself):
 *   actor (fresh user from the callback gate)  ->  resolveAiScope  (projects visible under the AI rules)
 *   ->  buildAiTaskFilter  (task visible under the AI rules: private tasks only for assignee / approver / project owner-manager,
 *       NO administrator bypass, a task is reachable only through a visible project)  ->  AND the requested relation / status / due.
 * The model supplies only enum values; every date boundary is computed by Node in the user's timezone.
 */

const STATUSES = [...Object.values(TASK_STATUS), 'open'];
const DUE = ['overdue', 'today', 'next_7_days', 'this_week', 'none'];
const RELATIONS = ['assigned', 'approver', 'owner'];
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

const argumentsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  due: z.enum(DUE).optional(),
  relation: z.enum(RELATIONS).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
}).strict();

const resultSchema = z.object({
  data: z.array(AI_SCHEMAS.task).max(MAX_LIMIT),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
  asOf: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(64) }).strict(),
  filters: z.object({ status: z.string().max(20), due: z.string().max(20).nullable(), relation: z.string().max(20) }).strict(),
}).strict();

const SELECT = 'title status priority dueDate project assignees';

function statusesFor(input) {
  const requested = input.status || 'open';
  const base = requested === 'open' ? OPEN_TASK_STATUSES : [requested];
  // "overdue" only ever means an OPEN task: asking for overdue Completed / Cancelled tasks is a contradiction and matches nothing.
  return input.due === 'overdue' ? base.filter((s) => OPEN_TASK_STATUSES.includes(s)) : base;
}

function createListMyTasksTool({ now = () => Date.now() } = {}) {
  return {
    name: 'list_my_tasks',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Looking up your tasks...',
    description: 'Lists the signed-in user\'s own tasks (assigned to them, awaiting their approval, or owned by them), with title, status, priority, due date, whether it is overdue, project and assignees. Use status "open" for pending work, due "overdue" for late tasks, relation "approver" with status "In Review" for tasks awaiting their review. Read-only; shows only tasks the user is allowed to see.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: ['status', 'due', 'relation', 'limit'],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const nowMs = now();
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor)); // user -> organization -> IST, validated
      const limit = input.limit || DEFAULT_LIMIT;
      const relation = input.relation || 'assigned';
      const window = dueWindow({ due: input.due || 'today', nowMs, timeZone }); // `today` is always needed for the overdue flag
      const today = window.today;
      const filters = { status: input.status || 'open', due: input.due || null, relation };
      const asOf = { date: today, timeZone };

      const scope = await aiScope.resolveAiScope(actor, { maxTimeMs });
      ensureActive(signal);

      const statuses = statusesFor(input);
      const empty = { data: [], summary: { count: 0, total: 0, truncated: false, complete: !scope.truncated }, asOf, filters };
      if (statuses.length === 0) return empty;

      const and = [buildAiTaskFilter(actor, scope), { status: { $in: statuses } }];
      if (relation === 'assigned') and.push({ assignees: actor._id });
      else if (relation === 'approver') and.push({ approvers: actor._id });
      else and.push({ $or: [{ owner: actor._id }, { project: { $in: scope.ownedProjectIds } }] }); // task owner, or owner of the task's project
      if (input.due) and.push({ dueDate: dueWindow({ due: input.due, nowMs, timeZone }).filter });
      const filter = { $and: and };

      const total = await guarded(signal, () => timed(Task.countDocuments(filter), maxTimeMs));
      if (total === 0) return empty;

      // Dated tasks first (soonest due first), then undated (newest first). Fetch one extra row to know whether more exist.
      let rows = [];
      if (input.due !== 'none') {
        rows = await guarded(signal, () => timed(Task.find({ $and: [...and, { dueDate: { $ne: null } }] }).sort({ dueDate: 1, _id: 1 }).limit(limit + 1).select(SELECT).lean(), maxTimeMs));
      }
      if (rows.length < limit + 1 && (!input.due || input.due === 'none')) {
        const undated = await guarded(signal, () => timed(Task.find({ $and: [...and, { dueDate: null }] }).sort({ createdAt: -1, _id: 1 }).limit(limit + 1 - rows.length).select(SELECT).lean(), maxTimeMs));
        rows = rows.concat(undated);
      }
      const more = rows.length > limit;
      rows = rows.slice(0, limit);

      const [names, projects] = await Promise.all([
        peopleNames(actor, rows.flatMap((t) => t.assignees || []), { signal, maxTimeMs }),
        projectNames(actor, rows.map((t) => t.project), { signal, maxTimeMs }),
      ]);
      const projected = rows.map((task) => projectTask(task, { names, project: { _id: task.project, name: projects.get(String(task.project)) || 'Project' }, today }));
      const fit = fitRows(projected, { reserveBytes: 600 });
      return {
        data: fit.rows,
        summary: { count: fit.rows.length, total, truncated: more || fit.truncated, complete: !scope.truncated },
        asOf,
        filters,
      };
    },
  };
}

module.exports = { argumentsSchema, createListMyTasksTool, resultSchema };
