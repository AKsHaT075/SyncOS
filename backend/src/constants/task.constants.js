const TASK_STATUS = Object.freeze({
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
});

const TASK_PRIORITY = Object.freeze({
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
});

const TASK_VISIBILITY = Object.freeze({
  PUBLIC: 'Public',
  PRIVATE: 'Private',
});

/**
 * Manual PATCH-driven transitions only. A manager can move a task between
 * any of these statuses at any time — Completed/Cancelled are not terminal,
 * since a manager may need to reopen or re-cancel a task later. IN_REVIEW is
 * the only status never reachable here — it only happens via the dedicated
 * submitForReview action (see task.service.js). An "Approved" reply no
 * longer auto-completes the task (it's just a reply), so the manager marks
 * it Completed manually once they're satisfied.
 */
const MANUALLY_REACHABLE_STATUSES = [TASK_STATUS.TODO, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED];
const TASK_STATUS_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.values(TASK_STATUS).map((status) => [
      status,
      MANUALLY_REACHABLE_STATUSES.filter((target) => target !== status),
    ])
  )
);

const TASK_REVIEW_ACTION = Object.freeze({
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CHANGES_REQUESTED: 'Changes Requested',
});

module.exports = {
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_VISIBILITY,
  TASK_STATUS_TRANSITIONS,
  TASK_REVIEW_ACTION,
};
