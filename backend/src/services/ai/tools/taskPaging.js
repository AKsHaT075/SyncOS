const { guarded, timed } = require('./toolSupport');
const Task = require('../../../models/Task');

/**
 * One page of tasks for a list tool: dated tasks first (soonest due, then id), then undated (newest first), fetching ONE extra row to
 * know whether more exist. `and` is the complete, already-authorized condition list (visibility filter included). Same ordering as
 * list_my_tasks. Nothing here decides who may see what.
 */
async function fetchTaskPage({ and, limit, due, select, signal, maxTimeMs }) {
  let rows = [];
  if (due !== 'none') {
    rows = await guarded(signal, () => timed(Task.find({ $and: [...and, { dueDate: { $ne: null } }] }).sort({ dueDate: 1, _id: 1 }).limit(limit + 1).select(select).lean(), maxTimeMs));
  }
  if (rows.length < limit + 1 && (!due || due === 'none')) {
    const undated = await guarded(signal, () => timed(Task.find({ $and: [...and, { dueDate: null }] }).sort({ createdAt: -1, _id: 1 }).limit(limit + 1 - rows.length).select(select).lean(), maxTimeMs));
    rows = rows.concat(undated);
  }
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

module.exports = { fetchTaskPage };
