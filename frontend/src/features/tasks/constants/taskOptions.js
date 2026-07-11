// Mirrors backend/src/constants/task.constants.js — keep these enums in sync.
export const TASK_STATUSES = ["Todo", "In Progress", "In Review", "Completed", "Cancelled"];
export const TASK_PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const TASK_VISIBILITIES = ["Public", "Private"];
export const TASK_REVIEW_ACTIONS = ["Approved", "Rejected", "Changes Requested"];

// Mirrors backend/src/constants/task.constants.js#TASK_STATUS_TRANSITIONS — a
// manual drag/edit may only move a task between these pairs. In Review and
// Completed are reachable only via Submit/Review actions, never a raw drag.
// Mirrors backend/src/constants/task.constants.js — a manager can move a
// task between any of these statuses at any time (Completed/Cancelled are
// not terminal). "In Review" is the only status never manually reachable —
// it only happens via Submit for Review.
const MANUALLY_REACHABLE_STATUSES = ["Todo", "In Progress", "Completed", "Cancelled"];
export const TASK_MANUAL_STATUS_TRANSITIONS = Object.fromEntries(
  [...MANUALLY_REACHABLE_STATUSES, "In Review"].map((status) => [
    status,
    MANUALLY_REACHABLE_STATUSES.filter((target) => target !== status),
  ])
);

export const KANBAN_COLUMNS = ["Todo", "In Progress", "In Review", "Completed", "Cancelled"];

export const STATUS_STYLES = {
  Todo: "bg-zinc-100 text-zinc-600",
  "In Progress": "bg-blue-50 text-blue-700",
  "In Review": "bg-amber-50 text-amber-700",
  Completed: "bg-emerald-50 text-emerald-700",
  Cancelled: "bg-red-50 text-red-700",
};

export const PRIORITY_STYLES = {
  Low: "bg-zinc-100 text-zinc-600",
  Medium: "bg-blue-50 text-blue-700",
  High: "bg-amber-50 text-amber-700",
  Critical: "bg-red-50 text-red-700",
};

export const VISIBILITY_STYLES = {
  Public: "bg-zinc-100 text-zinc-600",
  Private: "bg-violet-50 text-violet-700",
};
