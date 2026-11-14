const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');
const { PROJECT_MEMBER_ROLES, PROJECT_VISIBILITY } = require('../constants/project.constants');
const { TASK_VISIBILITY } = require('../constants/task.constants');
const { canViewTeam, TEAM_ADMIN_ROLES } = require('./teamAccess');

/**
 * AI-SPECIFIC visibility (Phase 8). Deliberately SEPARATE from the product's own access files (projectAccess, taskAccess,
 * meetingAccess, teamAccess, peopleAccess), which are untouched: what administrators can see in the application does not change.
 *
 * The one policy difference, approved as decision D1: an organization admin / admin gets NO bypass of a PRIVATE resource through
 * AI. A private project is visible to its owner and members only; a private task only to its assignees, listed approvers, and
 * the project's Owner / Manager-role members. Everything else follows the existing product rules (an admin keeps their ordinary
 * read access to non-private resources), and nothing here ever widens what the product allows.
 *
 *   - Each rule exists twice: a pure PREDICATE (check one loaded record) and a Mongo FILTER builder (select the visible ones).
 *     The two are tested against each other so they cannot drift.
 *   - Identity is always the freshly loaded user; nothing here accepts a role, id or organization from anywhere else.
 *   - A user without AI access (guest, super-admin, blocked, no organization) matches NOTHING.
 *
 * Membership is read from the actual data model: a project's `owner` is a separate field and is not necessarily repeated in
 * `members`, so "member" below always means owner-OR-listed-member.
 */

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const isSameId = (a, b) => Boolean(idOf(a)) && Boolean(idOf(b)) && idOf(a) === idOf(b);

const isAdminRole = (actor) => actor?.role === ROLES.ORG_ADMIN || actor?.role === ROLES.ADMIN;

/** May this user use AI against organizational data at all (current role, active, not blocked, has an organization)? */
function isAiEligible(actor) {
  return Boolean(actor?.organization)
    && actor.isActive !== false
    && !actor.orgBlocked
    && (ROLE_PERMISSIONS[actor.role] || []).includes(PERMISSIONS.USE_AI);
}

const NOTHING = Object.freeze({ _id: { $in: [] } }); // a filter that matches no document

// ---------------------------------------------------------------------------------------------------------------
// Projects

/** The user's standing on the project: 'Owner' (the owner field), their listed role, or null. Never an org-role shortcut. */
function projectRoleOf(actor, project) {
  if (isSameId(project.owner, actor._id)) return PROJECT_MEMBER_ROLES.OWNER;
  const entry = (project.members || []).find((member) => isSameId(member.user, actor._id));
  return entry ? entry.role : null;
}

/** Runs the project (Owner / Manager role). Org admin status alone never qualifies. */
function isAiProjectManager(actor, project) {
  const role = projectRoleOf(actor, project);
  return role === PROJECT_MEMBER_ROLES.OWNER || role === PROJECT_MEMBER_ROLES.MANAGER;
}

function canAiViewProject(actor, project, { includeArchived = false } = {}) {
  if (!isAiEligible(actor) || !project) return false;
  if (!isSameId(actor.organization, project.organization)) return false;
  if (project.deletedAt) return false;
  if (project.archived && !includeArchived) return false;
  if (projectRoleOf(actor, project)) return true; // owner or member, whatever the visibility
  if (project.visibility === PROJECT_VISIBILITY.PRIVATE) return false; // NO administrator bypass
  if (project.visibility === PROJECT_VISIBILITY.ORGANIZATION) return true;
  if (project.visibility === PROJECT_VISIBILITY.TEAM) return isAdminRole(actor) || isSameId(actor.team, project.team);
  return false;
}

/** Mongo filter (complete, including organization and lifecycle) for the projects the user may see through AI. */
function buildAiProjectFilter(actor, { includeArchived = false } = {}) {
  if (!isAiEligible(actor)) return { ...NOTHING };
  const or = [{ owner: actor._id }, { 'members.user': actor._id }, { visibility: PROJECT_VISIBILITY.ORGANIZATION }];
  if (isAdminRole(actor)) or.push({ visibility: PROJECT_VISIBILITY.TEAM });
  else if (actor.team) or.push({ visibility: PROJECT_VISIBILITY.TEAM, team: actor.team });
  // PRIVATE projects appear only through the first two branches (owner / member): there is no administrator branch.
  return { organization: actor.organization, deletedAt: null, ...(includeArchived ? {} : { archived: false }), $or: or };
}

/** Splits already-loaded AI-visible projects into the id sets the task / meeting filters need. */
function classifyProjects(actor, projects) {
  const visible = [];
  const member = [];
  const managed = [];
  const owned = [];
  for (const project of projects) {
    if (!canAiViewProject(actor, project, { includeArchived: true })) continue; // belt and braces: the query already filtered
    visible.push(project._id);
    if (projectRoleOf(actor, project)) member.push(project._id);
    if (isAiProjectManager(actor, project)) managed.push(project._id);
    if (isSameId(project.owner, actor._id)) owned.push(project._id); // the project's OWNER field (not a Manager role)
  }
  return { visibleProjectIds: visible, memberProjectIds: member, managedProjectIds: managed, ownedProjectIds: owned };
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks (a task is only ever reachable THROUGH a project the user can see)

function canAiViewTask(actor, project, task, { includeArchived = false } = {}) {
  if (!task || !canAiViewProject(actor, project, { includeArchived })) return false;
  if (!isSameId(task.organization, actor.organization) || !isSameId(task.project, project._id)) return false;
  if (task.deletedAt) return false;
  if (task.archived && !includeArchived) return false;

  if (isAiProjectManager(actor, project)) return true; // sees every task of the project, private included
  if ((task.assignees || []).some((user) => isSameId(user, actor._id))) return true;
  if ((task.approvers || []).some((user) => isSameId(user, actor._id))) return true;
  if (task.visibility === TASK_VISIBILITY.PUBLIC) return Boolean(projectRoleOf(actor, project)) || isAdminRole(actor);
  return false; // Private task, not attached: NO administrator bypass
}

/** `scope` = classifyProjects(...) for the same actor. Complete filter, including organization and lifecycle. */
function buildAiTaskFilter(actor, scope, { includeArchived = false } = {}) {
  if (!isAiEligible(actor)) return { ...NOTHING };
  return {
    organization: actor.organization,
    deletedAt: null,
    ...(includeArchived ? {} : { archived: false }),
    project: { $in: scope.visibleProjectIds },
    $or: [
      { project: { $in: scope.managedProjectIds } },
      { assignees: actor._id },
      { approvers: actor._id },
      { visibility: TASK_VISIBILITY.PUBLIC, project: { $in: isAdminRole(actor) ? scope.visibleProjectIds : scope.memberProjectIds } },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Meetings

function canAiViewMeeting(actor, project, meeting) {
  if (!meeting || !canAiViewProject(actor, project)) return false;
  if (!isSameId(meeting.organization, actor.organization) || !isSameId(meeting.project, project._id) || meeting.deletedAt) return false;
  if (isSameId(meeting.host, actor._id)) return true;
  if ((meeting.participants || []).some((entry) => isSameId(entry.user, actor._id))) return true;
  return Boolean(projectRoleOf(actor, project)) || isAdminRole(actor);
}

function buildAiMeetingFilter(actor, scope) {
  if (!isAiEligible(actor)) return { ...NOTHING };
  return {
    organization: actor.organization,
    deletedAt: null,
    project: { $in: scope.visibleProjectIds },
    $or: [{ host: actor._id }, { 'participants.user': actor._id }, { project: { $in: isAdminRole(actor) ? scope.visibleProjectIds : scope.memberProjectIds } }],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Teams and people

/** Same membership rule as the product (admin / HR see every team; anyone else only teams they lead or belong to). */
function canAiViewTeam(actor, team) {
  return isAiEligible(actor) && Boolean(team) && canViewTeam(actor, team);
}

function buildAiTeamFilter(actor) {
  if (!isAiEligible(actor)) return { ...NOTHING };
  if (TEAM_ADMIN_ROLES.includes(actor.role)) return { organization: actor.organization };
  return { organization: actor.organization, $or: [{ lead: actor._id }, { members: actor._id }] };
}

/**
 * Who may appear in an AI answer: ACTIVE, not blocked members of the same organization, for every role. This is stricter than
 * the directory (where admin / HR also see inactive accounts): a deactivated or blocked person is never surfaced through AI.
 * What is shown about a person is decided by the projection (name, organization role, team name), not by this filter.
 */
function canAiViewPerson(actor, person) {
  return isAiEligible(actor) && Boolean(person)
    && isSameId(person.organization, actor.organization) && person.isActive === true && !person.orgBlocked;
}

function buildAiPeopleFilter(actor) {
  if (!isAiEligible(actor)) return { ...NOTHING };
  return { organization: actor.organization, isActive: true, orgBlocked: { $ne: true } };
}

module.exports = {
  buildAiMeetingFilter,
  buildAiPeopleFilter,
  buildAiProjectFilter,
  buildAiTaskFilter,
  buildAiTeamFilter,
  canAiViewMeeting,
  canAiViewPerson,
  canAiViewProject,
  canAiViewTask,
  canAiViewTeam,
  classifyProjects,
  isAdminRole,
  isAiEligible,
  isAiProjectManager,
  projectRoleOf,
};
