const { ROLES } = require('../constants/roles');

/**
 * Team access rules:
 *  - ORG_ADMIN / ADMIN / HR can view and administer any team in their org.
 *  - Everyone else can view a team only if they are its lead or a member.
 *
 * Team administration (create/edit/members/manager) stays with
 * ORG_ADMIN / ADMIN / HR for v1 — a team lead is not an admin. If manager
 * self-management is wanted later, grant MANAGER the MANAGE_TEAM_MEMBERS
 * permission and extend canManageTeamMembers with an `isSameId(user._id,
 * team.lead)` check; no route or controller change is required.
 */

const TEAM_ADMIN_ROLES = [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR];

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function isSameId(a, b) {
  const idA = idOf(a);
  const idB = idOf(b);
  return Boolean(idA) && Boolean(idB) && idA === idB;
}

function canViewTeam(user, team) {
  if (!isSameId(user.organization, team.organization)) {
    return false;
  }

  if (TEAM_ADMIN_ROLES.includes(user.role)) {
    return true;
  }

  if (isSameId(user._id, team.lead)) {
    return true;
  }

  return team.members.some((member) => isSameId(member, user._id));
}

/** Gates member add/remove and manager assignment. */
function canManageTeamMembers(user, team) {
  if (!isSameId(user.organization, team.organization)) {
    return false;
  }
  return TEAM_ADMIN_ROLES.includes(user.role);
}

/** Returns 'lead' | 'member' | null for a user's standing on a team. */
function getTeamStanding(user, team) {
  if (!isSameId(user.organization, team.organization)) {
    return null;
  }
  if (isSameId(user._id, team.lead)) {
    return 'lead';
  }
  if (team.members.some((member) => isSameId(member, user._id))) {
    return 'member';
  }
  return null;
}

module.exports = {
  TEAM_ADMIN_ROLES,
  canManageTeamMembers,
  canViewTeam,
  getTeamStanding,
};