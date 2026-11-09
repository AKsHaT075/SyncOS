const mongoose = require('mongoose');
const { TASK_STATUS } = require('../../constants/task.constants');
const { ANALYTICS_LIMITS, OPEN_TASK_STATUSES, SCOPE_KIND } = require('../../constants/analytics.constants');
const Project = require('../../models/Project');
const Task = require('../../models/Task');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { COMPLETION_NOTE, idOf, percent, personNames, requireKind, run, sum, table } = require('./common');

const DAY_MS = 86400000;

/** Two [{_id:bucket, x}] aggregation results → one [{_id:bucket, x, y}] list. */
const mergeSeries = (...lists) => {
  const merged = new Map();
  lists.flat().forEach((row) => merged.set(row._id, { ...(merged.get(row._id) || {}), ...row }));
  return [...merged.values()];
};

/**
 * The Task filter for an analytics query: organization + live tasks + exactly what the actor may see (scope.taskMatch,
 * which mirrors listTasks/canViewTask) + the validated person / project filters.
 * `people: false` is used for project-level figures, which count a project's tasks regardless of assignee.
 */
function taskMatch(scope, filters = {}, { people = true } = {}) {
  const clauses = [{ organization: scope.organization, deletedAt: null, archived: false }];
  if (Object.keys(scope.taskMatch).length) clauses.push(scope.taskMatch);
  if (people && filters.personIds) clauses.push({ assignees: { $in: filters.personIds } });
  if (filters.projectId) clauses.push({ project: new mongoose.Types.ObjectId(filters.projectId) });
  return { $and: clauses };
}

const overdueCond = (range) => ({ $and: [{ $in: ['$status', OPEN_TASK_STATUSES] }, { $ne: ['$dueDate', null] }, { $lt: ['$dueDate', new Date(range.todayMs)] }] });
const inRange = (field, range) => ({ $and: [{ $gte: [field, range.start] }, { $lt: [field, range.end] }] });

/** Assigned / open / completed / overdue per person (one row per assignee), used by tasks, people and teams. */
async function perPersonTaskStats(scope, range, filters, { limit = ANALYTICS_LIMITS.MAX_PEOPLE } = {}) {
  const pipeline = [
    { $match: taskMatch(scope, filters) },
    { $unwind: '$assignees' },
    ...(filters.personIds ? [{ $match: { assignees: { $in: filters.personIds } } }] : []),
    {
      $group: {
        _id: '$assignees',
        assigned: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.COMPLETED] }, 1, 0] } },
        completedInRange: { $sum: { $cond: [{ $and: [{ $eq: ['$status', TASK_STATUS.COMPLETED] }, { $ne: ['$completedAt', null] }, inRange('$completedAt', range)] }, 1, 0] } },
        overdue: { $sum: { $cond: [overdueCond(range), 1, 0] } },
      },
    },
    { $sort: { open: -1, assigned: -1 } },
    { $limit: limit },
  ];
  return run(Task, pipeline);
}

async function computeTasks(scope, range, filters = {}) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM]);
  const match = { $match: taskMatch(scope, filters) };
  const projectLevel = { $match: taskMatch(scope, filters, { people: false }) };

  const [byStatus, byPriority, created, completed, completion, overdueByDue, noDate, byAssignee] = await Promise.all([
    run(Task, [match, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    run(Task, [match, {
      $group: {
        _id: '$priority', total: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.COMPLETED] }, 1, 0] } },
        overdue: { $sum: { $cond: [overdueCond(range), 1, 0] } },
      },
    }]),
    run(Task, [match, { $match: { createdAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: bucketExpr('$createdAt', range), created: { $sum: 1 } } }]),
    run(Task, [match, { $match: { status: TASK_STATUS.COMPLETED, completedAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: bucketExpr('$completedAt', range), completed: { $sum: 1 } } }]),
    run(Task, [match, { $match: { status: TASK_STATUS.COMPLETED, completedAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$completedAt', '$createdAt'] } }, n: { $sum: 1 } } }]),
    // Due dates are floating date-only values: bucket them in UTC, never in a timezone.
    run(Task, [match, { $match: { status: { $in: OPEN_TASK_STATUSES }, dueDate: { $gte: new Date(Date.parse(`${range.from}T00:00:00Z`)), $lt: new Date(range.todayMs) } } },
      { $group: { _id: { $dateToString: { format: range.format, date: '$dueDate', timezone: 'UTC' } }, overdue: { $sum: 1 } } }]),
    run(Task, [match, { $match: { status: TASK_STATUS.COMPLETED, completedAt: null } }, { $count: 'n' }]),
    perPersonTaskStats(scope, range, filters, { limit: ANALYTICS_LIMITS.TOP_N }),
  ]);

  const count = (status) => byStatus.find((row) => row._id === status)?.count || 0;
  const total = sum(byStatus.map((row) => ({ count: row.count })), 'count');
  const open = OPEN_TASK_STATUSES.reduce((acc, status) => acc + count(status), 0);
  const overdue = sum(byPriority, 'overdue');
  const finished = count(TASK_STATUS.COMPLETED);
  const names = await personNames(byAssignee.map((row) => row._id), scope.organization);

  const result = {
    kpis: {
      total, open, completed: finished, cancelled: count(TASK_STATUS.CANCELLED), overdue,
      completionRate: percent(finished, total - count(TASK_STATUS.CANCELLED)),
      createdInRange: sum(created, 'created'), completedInRange: sum(completed, 'completed'),
      avgCompletionDays: completion[0] ? Number((completion[0].avgMs / DAY_MS).toFixed(1)) : null,
      avgCompletionSample: completion[0]?.n || 0,
      completedWithoutDate: noDate[0]?.n || 0,
    },
    series: {
      createdVsCompleted: denseSeries(mergeSeries(created, completed), range, ['created', 'completed']),
      overdueByDueDate: denseSeries(overdueByDue, range, ['overdue']),
    },
    breakdowns: {
      byStatus: Object.values(TASK_STATUS).map((status) => ({ key: status, count: count(status) })),
      byPriority: byPriority.map((row) => ({ key: row._id, total: row.total, open: row.open, completed: row.completed, overdue: row.overdue })),
      byAssignee: byAssignee.map((row) => ({ id: idOf(row._id), name: names.get(idOf(row._id)) || 'Former member', assigned: row.assigned, open: row.open, completed: row.completed, overdue: row.overdue })),
    },
    notes: [COMPLETION_NOTE, 'Average completion time runs from task creation to completion.'],
  };

  if (scope.details) {
    const byProject = await run(Task, [projectLevel, {
      $group: {
        _id: '$project', total: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.COMPLETED] }, 1, 0] } },
        overdue: { $sum: { $cond: [overdueCond(range), 1, 0] } },
      },
    }, { $sort: { total: -1 } }, { $limit: ANALYTICS_LIMITS.TABLE_ROWS_MAX }]);
    const projects = await Project.find({ _id: { $in: byProject.map((row) => row._id) }, organization: scope.organization }).select('name').lean();
    const projectName = new Map(projects.map((project) => [idOf(project._id), project.name]));
    result.breakdowns.byProject = byProject.slice(0, ANALYTICS_LIMITS.TOP_N).map((row) => ({ id: idOf(row._id), name: projectName.get(idOf(row._id)) || 'Project', total: row.total, open: row.open, completed: row.completed, overdue: row.overdue }));
    result.table = table(
      [{ key: 'project', label: 'Project' }, { key: 'total', label: 'Tasks', type: 'number' }, { key: 'open', label: 'Open', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' }, { key: 'completionRate', label: 'Completion %', type: 'percent' }],
      byProject.map((row) => ({ project: projectName.get(idOf(row._id)) || 'Project', total: row.total, open: row.open, completed: row.completed, overdue: row.overdue, completionRate: percent(row.completed, row.total) })),
    );
  } else {
    // HR: counts by priority only. No project or task information of any kind.
    result.table = table(
      [{ key: 'priority', label: 'Priority' }, { key: 'total', label: 'Tasks', type: 'number' }, { key: 'open', label: 'Open', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' }],
      byPriority.map((row) => ({ priority: row._id, total: row.total, open: row.open, completed: row.completed, overdue: row.overdue })),
    );
  }
  return result;
}

module.exports = { computeTasks, inRange, mergeSeries, overdueCond, perPersonTaskStats, taskMatch };
