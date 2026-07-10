const { ROLES } = require('../constants/roles');
const { PROJECT_VISIBILITY, PROJECT_MEMBER_ROLES } = require('../constants/project.constants');

// `owner`/`members.user`/`team` may come in populated (a full document) or
// as a bare ObjectId depending on which query fetched the parent doc —
// always resolve through `_id` first so a populated doc's id is compared,
// not a stringified dump of the whole document.
function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function isSameId(a, b) {
  const idA = idOf(a);
  const idB = idOf(b);
  return Boolean(idA) && Boolean(idB) && idA === idB;
}

function isTeamMatch(user, project) {
  return isSameId(user.team, project.team);
}

/**
 * Project-level roles (Owner/Manager/Contributor/Viewer) are independent of
 * org roles — this is the only place that resolves "what is this user's
 * standing on this specific project".
 */
function getProjectMemberRole(project, userId) {
  if (isSameId(project.owner, userId)) {
    return PROJECT_MEMBER_ROLES.OWNER;
  }

  const member = project.members.find((entry) => isSameId(entry.user, userId));
  return member ? member.role : null;
}

/**
 * Org admins/admins see everything in their org. Anyone already on the
 * project (owner or member) can always view it, regardless of visibility.
 * Otherwise visibility decides: Organization is open to the whole org,
 * Team is open to the project's team, Private is member-only.
 */
function canViewProject(user, project) {
  if (!isSameId(user.organization, project.organization)) {
    return false;
  }

  if (user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN) {
    return true;
  }

  if (getProjectMemberRole(project, user._id)) {
    return true;
  }

  if (project.visibility === PROJECT_VISIBILITY.ORGANIZATION) {
    return true;
  }

  if (project.visibility === PROJECT_VISIBILITY.TEAM && isTeamMatch(user, project)) {
    return true;
  }

  return false;
}

/**
 * Gates update/archive/restore/member-management. Org admins/admins always
 * pass. A manager may manage projects owned by, staffed by, or belonging to
 * their own team — not every project in the org (unlike canDeleteProject,
 * whose existing org-wide-manager-delete contract is left untouched).
 * Project-level Owner/Manager members may also manage, independent of org role.
 */
function canManageProject(user, project) {
  if (!isSameId(user.organization, project.organization)) {
    return false;
  }

  if (user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN) {
    return true;
  }

  const memberRole = getProjectMemberRole(project, user._id);
  if (memberRole === PROJECT_MEMBER_ROLES.OWNER || memberRole === PROJECT_MEMBER_ROLES.MANAGER) {
    return true;
  }

  if (user.role === ROLES.MANAGER && isTeamMatch(user, project)) {
    return true;
  }

  return false;
}

/**
 * Mongo filter fragment (ANDed with { organization, deletedAt: null } by the
 * caller) that scopes a project list to what this user is allowed to see.
 * Org admins/admins get no extra restriction — they see the whole org.
 */
function buildProjectVisibilityFilter(user) {
  if (user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN) {
    return {};
  }

  const or = [
    { owner: user._id },
    { 'members.user': user._id },
    { visibility: PROJECT_VISIBILITY.ORGANIZATION },
  ];

  if (user.team) {
    or.push({ visibility: PROJECT_VISIBILITY.TEAM, team: user.team });
  }

  return { $or: or };
}

module.exports = {
  buildProjectVisibilityFilter,
  canManageProject,
  canViewProject,
  getProjectMemberRole,
};
