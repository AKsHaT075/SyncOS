const mongoose = require('mongoose');
const { PROJECT_STATUS } = require('../../constants/project.constants');
const { TASK_STATUS } = require('../../constants/task.constants');
const { ANALYTICS_LIMITS, OPEN_TASK_STATUSES, RUNNING_PROJECT_STATUSES, SCOPE_KIND } = require('../../constants/analytics.constants');
const AuditLog = require('../../models/AuditLog');
const Project = require('../../models/Project');
const Task = require('../../models/Task');
const Team = require('../../models/Team');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { idOf, percent, personNames, requireKind, run, table } = require('./common');
const { overdueCond, taskMatch } = require('./tasks');

const DAY_MS = 86400000;

function projectMatch(scope, filters) {
  const clauses = [{ organization: scope.organization, deletedAt: null }];
  if (Object.keys(scope.projectMatch).length) clauses.push(scope.projectMatch);
  if (filters.teamId) clauses.push({ team: new mongoose.Types.ObjectId(filters.teamId) });
  if (filters.projectId) clauses.push({ _id: new mongoose.Types.ObjectId(filters.projectId) });
  return { $and: clauses };
}

async function computeProjects(scope, range, filters = {}) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM]);
  const base = projectMatch(scope, filters);
  const active = { $and: [...base.$and, { archived: false }] };
  const today = new Date(range.todayMs);

  const [byStatus, byPriority, archived, durations, overdue, tableRows] = await Promise.all([
    run(Project, [{ $match: active }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    run(Project, [{ $match: active }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
    Project.countDocuments({ $and: [...base.$and, { archived: true }] }),
    run(Project, [{ $match: { ...active, startDate: { $ne: null }, dueDate: { $ne: null } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$dueDate', '$startDate'] } }, n: { $sum: 1 } } }]),
    Project.countDocuments({ $and: [...active.$and, { status: { $in: RUNNING_PROJECT_STATUSES }, dueDate: { $ne: null, $lt: today } }] }),
    scope.details ? Project.find(active).sort({ dueDate: 1, name: 1 }).limit(ANALYTICS_LIMITS.TABLE_ROWS_MAX).select('name status priority owner team dueDate startDate').lean() : [],
  ]);

  const count = (status) => byStatus.find((row) => row._id === status)?.count || 0;
  const total = byStatus.reduce((acc, row) => acc + row.count, 0);

  // Completion events come from the audit log: projects have no completion timestamp of their own.
  const completedFilter = { organization: scope.organization, action: 'project.status_changed', 'metadata.to': PROJECT_STATUS.COMPLETED, createdAt: { $gte: range.start, $lt: range.end } };
  if (scope.visibleProjectIds) completedFilter.entityId = { $in: scope.visibleProjectIds.map(idOf) };
  if (filters.projectId) completedFilter.entityId = filters.projectId;
  const completedEvents = await run(AuditLog, [{ $match: completedFilter }, { $group: { _id: bucketExpr('$createdAt', range), completed: { $sum: 1 } } }]);

  const result = {
    kpis: {
      total, active: count(PROJECT_STATUS.ACTIVE), completed: count(PROJECT_STATUS.COMPLETED), onHold: count(PROJECT_STATUS.ON_HOLD), planning: count(PROJECT_STATUS.PLANNING),
      archived, overdue, completionRate: percent(count(PROJECT_STATUS.COMPLETED), total),
      avgPlannedDurationDays: durations[0] ? Number((durations[0].avgMs / DAY_MS).toFixed(0)) : null,
      completedInRange: completedEvents.reduce((acc, row) => acc + row.completed, 0),
    },
    series: { completedOverTime: denseSeries(completedEvents, range, ['completed']) },
    breakdowns: {
      byStatus: Object.values(PROJECT_STATUS).filter((s) => s !== PROJECT_STATUS.ARCHIVED).map((status) => ({ key: status, count: count(status) })),
      byPriority: byPriority.map((row) => ({ key: row._id, count: row.count })),
    },
    notes: [
      'Projects do not store a completion date. "Completed over time" is built from status-change records in the audit log, so projects completed before those records existed are not included.',
      'Project duration is the planned length (start date to due date); actual duration is not recorded.',
      'Progress is the share of a project\'s tasks that are completed (cancelled tasks excluded); there is no stored progress value.',
    ],
  };

  if (!scope.details) {
    result.table = null; // HR: no per-project information
    return result;
  }

  // Task counts per project, restricted to tasks the actor may see.
  const counts = await run(Task, [
    { $match: taskMatch(scope, { ...filters, personIds: null }, { people: false }) },
    { $match: { project: { $in: tableRows.map((project) => project._id) } } },
    {
      $group: {
        _id: '$project', total: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.COMPLETED] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.CANCELLED] }, 1, 0] } },
        overdue: { $sum: { $cond: [overdueCond(range), 1, 0] } },
      },
    },
  ]);
  const byProject = new Map(counts.map((row) => [idOf(row._id), row]));
  const [names, teams] = await Promise.all([
    personNames(tableRows.map((project) => project.owner), scope.organization),
    Team.find({ _id: { $in: tableRows.map((project) => project.team).filter(Boolean) }, organization: scope.organization }).select('name').lean(),
  ]);
  const teamName = new Map(teams.map((team) => [idOf(team._id), team.name]));

  const rows = tableRows.map((project) => {
    const c = byProject.get(idOf(project._id)) || { total: 0, open: 0, completed: 0, cancelled: 0, overdue: 0 };
    return {
      project: project.name, status: project.status, priority: project.priority, team: teamName.get(idOf(project.team)) || '', owner: names.get(idOf(project.owner)) || '',
      dueDate: project.dueDate ? project.dueDate.toISOString().slice(0, 10) : '', tasks: c.total, open: c.open, completed: c.completed, overdue: c.overdue,
      progress: percent(c.completed, c.total - c.cancelled, 0),
    };
  });
  result.breakdowns.progressByProject = rows.filter((row) => row.tasks > 0).sort((a, b) => b.tasks - a.tasks).slice(0, ANALYTICS_LIMITS.TOP_N)
    .map((row) => ({ name: row.project, progress: row.progress ?? 0, tasks: row.tasks }));
  result.table = table(
    [{ key: 'project', label: 'Project' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'team', label: 'Team' }, { key: 'owner', label: 'Owner' },
      { key: 'dueDate', label: 'Due date', type: 'date' }, { key: 'tasks', label: 'Tasks', type: 'number' }, { key: 'open', label: 'Open', type: 'number' },
      { key: 'completed', label: 'Completed', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' }, { key: 'progress', label: 'Progress %', type: 'percent' }],
    rows,
  );
  return result;
}

module.exports = { computeProjects, projectMatch };
