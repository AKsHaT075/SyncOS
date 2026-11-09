const { TASK_STATUS } = require('../../constants/task.constants');
const { ANALYTICS_LIMITS, OPEN_TASK_STATUSES, SCOPE_KIND } = require('../../constants/analytics.constants');
const { ASSIGNMENT_STATUS } = require('../../constants/asset.constants');
const AssetAssignment = require('../../models/AssetAssignment');
const Asset = require('../../models/Asset');
const AuditLog = require('../../models/AuditLog');
const Meeting = require('../../models/Meeting');
const Project = require('../../models/Project');
const Task = require('../../models/Task');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { computeMeetings } = require('./meetings');
const { COMPLETION_NOTE, idOf, percent, run, sum } = require('./common');
const { mergeSeries, overdueCond } = require('./tasks');

const DAY_MS = 86400000;

/** The actor's own data, whatever their role. Never touches anyone else's records. */
async function computePersonal(scope, range) {
  const me = scope.actor._id;
  const org = scope.organization;
  const mine = { $match: { organization: org, deletedAt: null, archived: false, assignees: me } };
  const today = new Date(range.todayMs);
  const soon = new Date(range.todayMs + ANALYTICS_LIMITS.UPCOMING_DAYS * DAY_MS);

  const [byStatus, overdue, created, completed, workload, upcoming, overdueList] = await Promise.all([
    run(Task, [mine, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Task.countDocuments({ organization: org, deletedAt: null, archived: false, assignees: me, status: { $in: OPEN_TASK_STATUSES }, dueDate: { $ne: null, $lt: today } }),
    run(Task, [mine, { $match: { createdAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: bucketExpr('$createdAt', range), created: { $sum: 1 } } }]),
    run(Task, [mine, { $match: { status: TASK_STATUS.COMPLETED, completedAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: bucketExpr('$completedAt', range), completed: { $sum: 1 } } }]),
    run(Task, [mine, { $match: { status: { $in: OPEN_TASK_STATUSES } } }, { $group: { _id: null, open: { $sum: 1 }, hours: { $sum: { $ifNull: ['$estimatedHours', 0] } }, overdue: { $sum: { $cond: [overdueCond(range), 1, 0] } }, dueSoon: { $sum: { $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $gte: ['$dueDate', today] }, { $lt: ['$dueDate', soon] }] }, 1, 0] } } } }]),
    Task.find({ organization: org, deletedAt: null, archived: false, assignees: me, status: { $in: OPEN_TASK_STATUSES }, dueDate: { $gte: today, $lt: soon } }).sort({ dueDate: 1 }).limit(10).populate('project', 'name').select('title dueDate priority status project').lean(),
    Task.find({ organization: org, deletedAt: null, archived: false, assignees: me, status: { $in: OPEN_TASK_STATUSES }, dueDate: { $ne: null, $lt: today } }).sort({ dueDate: 1 }).limit(5).populate('project', 'name').select('title dueDate priority status project').lean(),
  ]);

  const count = (status) => byStatus.find((row) => row._id === status)?.count || 0;
  const total = byStatus.reduce((acc, row) => acc + row.count, 0);
  const w = workload[0] || { open: 0, hours: 0, overdue: 0, dueSoon: 0 };

  const [projects, meetings, upcomingMeetings, assignments, recent, activity] = await Promise.all([
    Project.find({ organization: org, deletedAt: null, archived: false, $or: [{ owner: me }, { 'members.user': me }] }).select('name status owner members').limit(30).lean(),
    computeMeetings({ ...scope, kind: SCOPE_KIND.SELF, details: false, personIds: [me] }, range),
    Meeting.find({ organization: org, status: 'Scheduled', startTime: { $gte: new Date() }, $or: [{ host: me }, { 'participants.user': me }] }).sort({ startTime: 1 }).limit(5).select('topic startTime').lean(),
    AssetAssignment.find({ organization: org, status: ASSIGNMENT_STATUS.ACTIVE, user: me }).select('asset assignedAt').limit(30).lean(),
    AuditLog.find({ organization: org, user: me }).sort({ createdAt: -1 }).limit(10).select('action entityType createdAt').lean(),
    run(AuditLog, [{ $match: { organization: org, user: me, createdAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: bucketExpr('$createdAt', range), actions: { $sum: 1 } } }]),
  ]);
  const assets = assignments.length ? await Asset.find({ _id: { $in: assignments.map((a) => a.asset) }, organization: org, deletedAt: null }).select('name assetId kind status').lean() : [];

  return {
    kpis: {
      assigned: total, open: w.open, completed: count(TASK_STATUS.COMPLETED), completedInRange: sum(completed, 'completed'), overdue, dueSoon: w.dueSoon,
      completionRate: percent(count(TASK_STATUS.COMPLETED), total - count(TASK_STATUS.CANCELLED)), estimatedHoursOpen: w.hours,
      projects: projects.length, assets: assets.length,
      meetings: meetings.kpis.total, meetingsAttended: meetings.kpis.attended, meetingAttendanceRate: meetings.kpis.attendanceRate,
    },
    series: { createdVsCompleted: denseSeries(mergeSeries(created, completed), range, ['created', 'completed']), activity: denseSeries(activity, range, ['actions']), meetings: meetings.series.meetingsOverTime },
    breakdowns: { byStatus: Object.values(TASK_STATUS).map((status) => ({ key: status, count: count(status) })), meetingsByStatus: meetings.breakdowns.byStatus },
    lists: {
      upcomingDeadlines: upcoming.map((task) => ({ id: idOf(task._id), title: task.title, project: task.project?.name || '', dueDate: task.dueDate.toISOString().slice(0, 10), priority: task.priority, status: task.status })),
      overdueTasks: overdueList.map((task) => ({ id: idOf(task._id), title: task.title, project: task.project?.name || '', dueDate: task.dueDate.toISOString().slice(0, 10), priority: task.priority })),
      projects: projects.map((project) => ({ id: idOf(project._id), name: project.name, status: project.status, role: idOf(project.owner) === idOf(me) ? 'Owner' : project.members.find((m) => idOf(m.user) === idOf(me))?.role || 'Member' })),
      upcomingMeetings: upcomingMeetings.map((meeting) => ({ id: idOf(meeting._id), topic: meeting.topic, start: meeting.startTime.toISOString() })),
      assets: assets.map((asset) => ({ id: idOf(asset._id), name: asset.name, assetId: asset.assetId, kind: asset.kind, status: asset.status })),
      recentActivity: recent.map((entry) => ({ action: entry.action, entityType: entry.entityType, at: entry.createdAt.toISOString() })),
    },
    notes: [COMPLETION_NOTE, 'Everything on this page is about your own work only.'],
  };
}

module.exports = { computePersonal };
