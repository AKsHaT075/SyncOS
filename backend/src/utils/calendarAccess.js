const { EVENT_TYPES, EVENT_VISIBILITY } = require('../constants/calendar.constants');
const { PERMISSIONS } = require('../constants/permissions');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');
const { ROLES } = require('../constants/roles');
const { TEAM_ADMIN_ROLES } = require('./teamAccess');

/**
 * Calendar event access rules (single place; services never re-implement them).
 *
 * VIEW
 *   owner / invited attendee ........ always
 *   personal events ................. only those two (even admins can't see them)
 *   team events ..................... team members + lead; org-admin/admin/HR (team admins)
 *   project (general) events ........ members of the project; org-admin/admin
 *   organization events ............. every org member except guests
 *   org-admin / admin ............... everything except personal events
 *   GUEST ........................... only events they own/are invited to, or whose
 *                                     project they are an explicit member of
 * MANAGE (edit / delete)
 *   personal / general .............. owner (needs CREATE_EVENT); project events also
 *                                     the project's owner/manager and org admins
 *   team ............................ CURRENT authority only: the team's lead, or
 *                                     org-admin/admin/HR — being the creator is not enough
 *                                     (a manager who stopped leading the team loses it)
 *   organization .................... org-admin/admin/HR only
 * CREATE follows MANAGE for the chosen type (see canCreateEventOfType).
 *
 * `ctx` = { user, teamIds:Set, ledTeamIds:Set, projectIds:Set, managedProjectIds:Set }
 */

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const isSame = (a, b) => Boolean(idOf(a)) && idOf(a) === idOf(b);

const hasPermission = (user, permission) => (ROLE_PERMISSIONS[user.role] || []).includes(permission);
const isOrgAdmin = (user) => user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN;
const isGuest = (user) => user.role === ROLES.GUEST;
const isTeamAdmin = (user) => TEAM_ADMIN_ROLES.includes(user.role);

function buildCalendarContext(user, { teamIds = [], ledTeamIds = [], projectIds = [], managedProjectIds = [] } = {}) {
  return {
    user,
    teamIds: new Set(teamIds),
    ledTeamIds: new Set(ledTeamIds),
    projectIds: new Set(projectIds),
    managedProjectIds: new Set(managedProjectIds),
  };
}

const isAttendee = (event, userId) => (event.attendees || []).some((a) => isSame(a.user, userId));
const attendeeEntry = (event, userId) => (event.attendees || []).find((a) => isSame(a.user, userId)) || null;

function canViewEvent(ctx, event) {
  const { user } = ctx;
  if (!user || !isSame(user.organization, event.organization)) return false;
  if (isSame(event.owner, user._id) || isAttendee(event, user._id)) return true;
  if (event.type === EVENT_TYPES.PERSONAL) return false;
  if (isOrgAdmin(user)) return true;

  if (event.visibility === EVENT_VISIBILITY.PROJECT) {
    return ctx.projectIds.has(idOf(event.project));
  }
  if (isGuest(user)) return false;
  if (event.visibility === EVENT_VISIBILITY.ORGANIZATION) return true;
  if (event.visibility === EVENT_VISIBILITY.TEAM) return isTeamAdmin(user) || ctx.teamIds.has(idOf(event.team));
  return false;
}

function canCreateEventOfType(ctx, { type, team = null, project = null }) {
  const { user } = ctx;
  if (!hasPermission(user, PERMISSIONS.CREATE_EVENT)) return false;
  switch (type) {
    case EVENT_TYPES.PERSONAL:
      return true;
    case EVENT_TYPES.GENERAL:
      // Linked to a project: only people who manage it (or org admins).
      return !project || isOrgAdmin(user) || ctx.managedProjectIds.has(idOf(project));
    case EVENT_TYPES.TEAM:
      return isOrgAdmin(user) || user.role === ROLES.HR || ctx.ledTeamIds.has(idOf(team));
    case EVENT_TYPES.ORGANIZATION:
      return isOrgAdmin(user) || user.role === ROLES.HR;
    default:
      return false;
  }
}

function canManageEvent(ctx, event) {
  const { user } = ctx;
  if (!canViewEvent(ctx, event) || !hasPermission(user, PERMISSIONS.CREATE_EVENT)) return false;

  switch (event.type) {
    case EVENT_TYPES.PERSONAL:
      return isSame(event.owner, user._id);
    case EVENT_TYPES.GENERAL:
      return (
        isSame(event.owner, user._id) ||
        isOrgAdmin(user) ||
        (Boolean(event.project) && ctx.managedProjectIds.has(idOf(event.project)))
      );
    case EVENT_TYPES.TEAM:
      return isOrgAdmin(user) || user.role === ROLES.HR || ctx.ledTeamIds.has(idOf(event.team));
    case EVENT_TYPES.ORGANIZATION:
      return isOrgAdmin(user) || user.role === ROLES.HR;
    default:
      return false;
  }
}

/**
 * Mongo fragment (ANDed with { organization, deletedAt }) selecting events
 * the user may view — a coarse pre-filter; canViewEvent is the final check.
 */
function buildEventVisibilityFilter(ctx) {
  const { user } = ctx;
  const or = [{ owner: user._id }, { 'attendees.user': user._id }];
  const projectIds = [...ctx.projectIds];
  const teamIds = [...ctx.teamIds];

  if (isOrgAdmin(user)) {
    or.push({ type: { $ne: EVENT_TYPES.PERSONAL } });
    return { $or: or };
  }
  if (projectIds.length) or.push({ visibility: EVENT_VISIBILITY.PROJECT, project: { $in: projectIds } });
  if (!isGuest(user)) {
    or.push({ visibility: EVENT_VISIBILITY.ORGANIZATION });
    if (isTeamAdmin(user)) or.push({ visibility: EVENT_VISIBILITY.TEAM });
    else if (teamIds.length) or.push({ visibility: EVENT_VISIBILITY.TEAM, team: { $in: teamIds } });
  }
  return { $or: or };
}

module.exports = {
  attendeeEntry,
  buildCalendarContext,
  buildEventVisibilityFilter,
  canCreateEventOfType,
  canManageEvent,
  canViewEvent,
  hasPermission,
  idOf,
  isAttendee,
  isGuest,
  isOrgAdmin,
  isSame,
  isTeamAdmin,
};
