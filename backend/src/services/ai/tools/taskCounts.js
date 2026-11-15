const { OPEN_TASK_STATUSES } = require('../../../constants/analytics.constants');
const Task = require('../../../models/Task');
const { buildAiTaskFilter } = require('../../../utils/aiAccess');
const { guarded } = require('./toolSupport');

/**
 * Task counts for project tools. They are computed from EXACTLY the filter the row lists use (buildAiTaskFilter), so a count can
 * never include a task the user could not also see in a list: no hidden-task counts, no unrestricted analytics aggregation.
 * "Overdue" is the task-list definition: an OPEN task whose due date is strictly before today (floating date, UTC-midnight compare).
 */

const OPEN = OPEN_TASK_STATUSES;
const overdueExpr = (todayUtc) => ({ $cond: [{ $and: [{ $in: ['$status', OPEN] }, { $ne: ['$dueDate', null] }, { $lt: ['$dueDate', todayUtc] }] }, 1, 0] });

/** Map(projectId string -> { open, overdue }) for the given projects, under `scope`'s task visibility. */
async function openCountsByProject(actor, scope, projectIds, todayUtc, { signal, maxTimeMs } = {}) {
  const out = new Map();
  if (projectIds.length === 0) return out;
  const rows = await guarded(signal, () => Task.aggregate([
    { $match: { $and: [buildAiTaskFilter(actor, scope), { project: { $in: projectIds } }, { status: { $in: OPEN } }] } },
    { $group: { _id: '$project', open: { $sum: 1 }, overdue: { $sum: overdueExpr(todayUtc) } } },
  ]).option({ maxTimeMS: maxTimeMs }).exec());
  for (const row of rows) out.set(String(row._id), { open: row.open, overdue: row.overdue });
  return out;
}

const KEYS = { Todo: 'todo', 'In Progress': 'inProgress', 'In Review': 'inReview', Completed: 'completed', Cancelled: 'cancelled' };

/** { todo, inProgress, inReview, completed, cancelled, overdue } for ONE project under `scope`'s task visibility. */
async function statusBreakdown(actor, scope, projectId, todayUtc, { signal, maxTimeMs } = {}) {
  const rows = await guarded(signal, () => Task.aggregate([
    { $match: { $and: [buildAiTaskFilter(actor, scope), { project: projectId }] } },
    { $group: { _id: '$status', n: { $sum: 1 }, overdue: { $sum: overdueExpr(todayUtc) } } },
  ]).option({ maxTimeMS: maxTimeMs }).exec());
  const out = { todo: 0, inProgress: 0, inReview: 0, completed: 0, cancelled: 0, overdue: 0 };
  for (const row of rows) {
    if (KEYS[row._id]) out[KEYS[row._id]] = row.n;
    out.overdue += row.overdue;
  }
  return out;
}

module.exports = { openCountsByProject, statusBreakdown };
