import { ROLES } from "@/constants/roles";

// Mirrors backend/src/utils/taskAccess.js — used only to decide which
// actions to show; the backend re-checks authoritatively on every request,
// so a stale/optimistic result here is never a security issue.
function isOrgAdmin(authUser) {
  return authUser?.role === ROLES.ORG_ADMIN || authUser?.role === ROLES.ADMIN;
}

function isProjectTaskManager(project, authUser) {
  if (isOrgAdmin(authUser)) return true;
  return project?.myRole === "Owner" || project?.myRole === "Manager";
}

export function canCreateTaskClient(project, authUser) {
  return isProjectTaskManager(project, authUser);
}

export function canManageTaskClient(project, authUser) {
  return isProjectTaskManager(project, authUser);
}

export function isTaskAssigneeClient(task, authUser) {
  if (!task || !authUser) return false;
  return (task.assignees || []).some((assignee) => assignee?.id === authUser.id);
}

export function canEditTaskClient(project, task, authUser) {
  if (task?.status === "Completed") {
    return canManageTaskClient(project, authUser);
  }
  return canManageTaskClient(project, authUser) || isTaskAssigneeClient(task, authUser);
}

export function canSubmitForReviewClient(task, authUser) {
  return (
    isTaskAssigneeClient(task, authUser) &&
    (task?.status === "In Progress" || task?.status === "In Review")
  );
}

export function canApproveTaskClient(project, task, authUser) {
  if (isProjectTaskManager(project, authUser)) return true;
  return (task?.approvers || []).some((approver) => approver?.id === authUser?.id);
}
