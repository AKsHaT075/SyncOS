const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { ROLES } = require('../../../constants/roles');
const { OPEN_TASK_STATUSES, SCOPE_KIND } = require('../../../constants/analytics.constants');
const { TASK_STATUS } = require('../../../constants/task.constants');
const Task = require('../../../models/Task');
const Team = require('../../../models/Team');
const User = require('../../../models/User');
const { buildAiPeopleFilter, buildAiTaskFilter } = require('../../../utils/aiAccess');
const { dueWindow } = require('../../../utils/aiDateRanges');
const { resolveTimeZone } = require('../../calendar.service');
const aiScope = require('./aiScope');
const { ensureActive, guarded, timed } = require('./toolSupport');

/**
 * get_workload_summary: how much work is there, for ME, for the team I LEAD, or (admin / HR) for the ORGANIZATION.
 *
 * It does NOT reuse the analytics aggregations: those include private tasks for admins and return per-person rows (names + counts),
 * even for HR. Here every number is one aggregate over the SAME task filter the AI row lists use (buildAiTaskFilter), so a private task
 * the person could not see through AI is never counted, whatever their organization role. Analytics is reused only for its scope
 * kinds (who is organization / aggregate / team / self) and for the open-status and overdue definitions.
 *
 * What leaves this file is a fixed set of integers. No ids, names, titles, per-person figures or breakdowns, and no group below
 * MIN_COHORT active people is ever summarised (it would identify individuals).
 */

const SCOPES = ['me', 'my_team', 'organization'];
const MIN_COHORT = 5;
const OPEN = OPEN_TASK_STATUSES;

// Same role -> kind mapping as services/analytics/scope.js (a test asserts parity against resolveScope).
const KIND_BY_ROLE = Object.freeze({
  [ROLES.ORG_ADMIN]: SCOPE_KIND.ORGANIZATION,
  [ROLES.ADMIN]: SCOPE_KIND.ORGANIZATION,
  [ROLES.HR]: SCOPE_KIND.AGGREGATE,
  [ROLES.MANAGER]: SCOPE_KIND.TEAM,
  [ROLES.EMPLOYEE]: SCOPE_KIND.SELF,
});

const REASONS = ['role_not_permitted', 'no_team_led', 'group_too_small'];
const BASIS = 'Tasks you can see, not archived or deleted. Open = To Do, In Progress, In Review. Overdue = open and due before today; due today is not overdue. Report these numbers exactly.';
const METRICS = ['totalTasks', 'todoTasks', 'inProgressTasks', 'inReviewTasks', 'completedTasks', 'cancelledTasks', 'openTasks', 'overdueTasks', 'dueToday', 'noDueDate'];

const argumentsSchema = z.object({ scope: z.enum(SCOPES).optional() }).strict();

const count = z.number().int().min(0).nullable();
const resultSchema = z.object({
  outcome: z.enum(['ok', 'not_available']),
  reason: z.enum(REASONS).nullable(),
  scope: z.enum(SCOPES),
  asOf: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(64) }).strict(),
  totalTasks: count,
  todoTasks: count,
  inProgressTasks: count,
  inReviewTasks: count,
  completedTasks: count,
  cancelledTasks: count,
  openTasks: count,
  overdueTasks: count,
  dueToday: count,
  noDueDate: count,
  peopleInScope: count,
  complete: z.boolean(),
  basis: z.string().max(200),
}).strict();

const unavailable = (scope, asOf, reason) => ({
  outcome: 'not_available', reason, scope, asOf,
  ...Object.fromEntries(METRICS.map((key) => [key, null])),
  peopleInScope: null, complete: true, basis: BASIS,
});

/** One aggregate over the tasks matched by `match`. A single $group row; nothing per person, project or task leaves it. */
async function summarize(match, todayUtc, { signal, maxTimeMs }) {
  const inStatus = (status) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });
  const openAnd = (...rest) => ({ $sum: { $cond: [{ $and: [{ $in: ['$status', OPEN] }, ...rest] }, 1, 0] } });
  const [row] = await guarded(signal, () => Task.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalTasks: { $sum: 1 },
        todoTasks: inStatus(TASK_STATUS.TODO),
        inProgressTasks: inStatus(TASK_STATUS.IN_PROGRESS),
        inReviewTasks: inStatus(TASK_STATUS.IN_REVIEW),
        completedTasks: inStatus(TASK_STATUS.COMPLETED),
        cancelledTasks: inStatus(TASK_STATUS.CANCELLED),
        openTasks: openAnd(),
        overdueTasks: openAnd({ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', todayUtc] }),
        dueToday: openAnd({ $eq: ['$dueDate', todayUtc] }),
        noDueDate: openAnd({ $eq: [{ $ifNull: ['$dueDate', null] }, null] }),
      },
    },
  ]).option({ maxTimeMS: maxTimeMs }).exec());
  return Object.fromEntries(METRICS.map((key) => [key, row ? row[key] : 0]));
}

function createGetWorkloadSummaryTool({ now = () => Date.now() } = {}) {
  return {
    name: 'get_workload_summary',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Summarising workload...',
    description: 'Counts tasks: total, to do, in progress, in review, completed, cancelled, open, overdue, due today and open without a due date. scope "me" (default) is the signed-in user\'s own assigned tasks; "my_team" is the teams they lead (managers, needs at least 5 people); "organization" is administrators and HR only (aggregate counts, needs at least 5 people). It never names people or tasks and never gives per-person figures. Only tasks the user can see are counted; private tasks they cannot access are never included. Report the returned numbers exactly; if outcome is not_available, say so and do not estimate.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: ['scope'],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const scopeName = input.scope || 'me';
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor));
      const { today } = dueWindow({ due: 'today', nowMs: now(), timeZone });
      const todayUtc = new Date(`${today}T00:00:00.000Z`);
      const asOf = { date: today, timeZone };
      const kind = KIND_BY_ROLE[actor.role] || SCOPE_KIND.NONE;

      // Who may ask for which scope. Anything else is a fixed, safe "not available" (never an error that names a reason about others).
      if (kind === SCOPE_KIND.NONE) return unavailable(scopeName, asOf, 'role_not_permitted');
      if (scopeName === 'organization' && ![SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE].includes(kind)) return unavailable(scopeName, asOf, 'role_not_permitted');
      if (scopeName === 'my_team' && ![SCOPE_KIND.TEAM, SCOPE_KIND.ORGANIZATION].includes(kind)) return unavailable(scopeName, asOf, 'role_not_permitted');

      // The person cohort for a group scope. Teams are ones the user LEADS (a manager is not an organization-wide manager).
      let peopleIds = null;
      let peopleInScope = null;
      if (scopeName === 'my_team') {
        const teams = await guarded(signal, () => timed(Team.find({ organization: actor.organization, lead: actor._id }).select('lead members').limit(200).lean(), maxTimeMs));
        if (teams.length === 0) return unavailable(scopeName, asOf, 'no_team_led');
        const ids = [...new Set(teams.flatMap((team) => [team.lead, ...(team.members || [])]).filter(Boolean).map(String))];
        const active = await guarded(signal, () => timed(User.find({ _id: { $in: ids }, ...buildAiPeopleFilter(actor) }).select('_id').lean(), maxTimeMs));
        peopleIds = active.map((person) => person._id);
        peopleInScope = peopleIds.length;
      } else if (scopeName === 'organization') {
        peopleInScope = await guarded(signal, () => timed(User.countDocuments(buildAiPeopleFilter(actor)), maxTimeMs));
      }
      if (peopleInScope !== null && peopleInScope < MIN_COHORT) return unavailable(scopeName, asOf, 'group_too_small');

      const scope = await aiScope.resolveAiScope(actor, { maxTimeMs });
      ensureActive(signal);
      const visible = buildAiTaskFilter(actor, scope);
      let match = visible;
      if (scopeName === 'me') match = { $and: [visible, { assignees: actor._id }] };
      else if (scopeName === 'my_team') match = { $and: [visible, { assignees: { $in: peopleIds } }] };

      const metrics = await summarize(match, todayUtc, { signal, maxTimeMs });
      return { outcome: 'ok', reason: null, scope: scopeName, asOf, ...metrics, peopleInScope, complete: !scope.truncated, basis: BASIS };
    },
  };
}

module.exports = { MIN_COHORT, argumentsSchema, createGetWorkloadSummaryTool, resultSchema };
