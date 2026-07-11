const { ROLES } = require('../constants/roles');
const { PROJECT_MEMBER_ROLES } = require('../constants/project.constants');
const { TASK_VISIBILITY, TASK_STATUS } = require('../constants/task.constants');
const { getProjectMemberRole } = require('./projectAccess');

// `assignees`/`approvers`/`owner` on a Task may come in populated or as bare
// ObjectIds depending on the query that loaded the parent doc.
function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function isSameId(a, b) {
  const idA = idOf(a);
  const idB = idOf(b);
  return Boolean(idA) && Boolean(idB) && idA === idB;
}

function includesId(list, userId) {
  return (list || []).some((entry) => isSameId(entry, userId));
}

function isOrgAdmin(user) {
  return user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN;
}

/**
 * True for the same set of people who are allowed to create tasks: org
 * admins/admins, the project Owner, or a project member whose PROJECT ROLE
 * (not org role) is Manager. A project's org-role `manager` team-match
 * (which canManageProject grants for Projects) is deliberately NOT included
 * here — the task spec only names project Owner/Manager-role membership.
 */
function isProjectTaskManager(user, project) {
  if (isOrgAdmin(user)) return true;
  const memberRole = getProjectMemberRole(project, user._id);
  return memberRole === PROJECT_MEMBER_ROLES.OWNER || memberRole === PROJECT_MEMBER_ROLES.MANAGER;
}

function canCreateTask(user, project) {
  if (!isSameId(user.organization, project.organization)) return false;
  return isProjectTaskManager(user, project);
}

function isTaskAssignee(user, task) {
  return includesId(task.assignees, user._id);
}

/**
 * PUBLIC tasks are visible to any project member. PRIVATE tasks are
 * restricted to assignees, listed approvers, project Owner/Manager-role
 * members, and org admins/admins.
 */
function canViewTask(user, project, task) {
  if (!isSameId(user.organization, project.organization)) return false;
  if (isOrgAdmin(user)) return true;

  const memberRole = getProjectMemberRole(project, user._id);

  if (task.visibility === TASK_VISIBILITY.PUBLIC) {
    return Boolean(memberRole);
  }

  // PRIVATE
  if (memberRole === PROJECT_MEMBER_ROLES.OWNER || memberRole === PROJECT_MEMBER_ROLES.MANAGER) return true;
  if (isTaskAssignee(user, task)) return true;
  if (includesId(task.approvers, user._id)) return true;

  return false;
}

/**
 * Full manage rights (edit fields, reassign, change priority/dates, manual
 * status transitions, archive/delete) — the same population that can
 * create tasks. Assignees who are plain Contributors/Viewers do not qualify
 * even though they can view and submit their own work.
 */
function canManageTask(user, project, task) {
  if (!isSameId(user.organization, project.organization)) return false;
  return isProjectTaskManager(user, project);
}

/**
 * Completed tasks are locked down to managers/admins only — nobody edits a
 * signed-off task by "just fixing a typo" without that being deliberate.
 */
function canEditTask(user, project, task) {
  if (task.status === TASK_STATUS.COMPLETED) {
    return canManageTask(user, project, task);
  }
  return canManageTask(user, project, task) || isTaskAssignee(user, task);
}

/**
 * Only an assignee may submit their own work for review, and only while
 * it's actively In Progress.
 */
function canSubmitForReview(user, task) {
  return (
    isTaskAssignee(user, task) &&
    (task.status === TASK_STATUS.IN_PROGRESS || task.status === TASK_STATUS.IN_REVIEW)
  );
}

/**
 * Approvers are: org admins/admins, the project Owner, a project-role
 * Manager member, or anyone the task creator explicitly listed in
 * `task.approvers`. Being merely an assignee never qualifies — this is what
 * guarantees a contributor can never approve (and thus never complete)
 * their own task.
 */
function canApproveTask(user, project, task) {
  if (!isSameId(user.organization, project.organization)) return false;
  if (isProjectTaskManager(user, project)) return true;
  return includesId(task.approvers, user._id);
}

module.exports = {
  canApproveTask,
  canCreateTask,
  canEditTask,
  canManageTask,
  canSubmitForReview,
  canViewTask,
  isProjectTaskManager,
  isTaskAssignee,
};
