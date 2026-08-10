const { ROLES } = require('../constants/roles');
const { canManageProject, getProjectMemberRole } = require('./projectAccess');

// `host`/`participants.user` on a Meeting may come in populated or as bare
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

function isOrgAdmin(user) {
  return user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN;
}

/**
 * The population that can schedule/manage meetings for a project is exactly
 * the population that can manage the project itself (org-admin/admin,
 * project Owner/Manager-role members, org-role Manager with a team match) —
 * "Managers, Project Managers, Org Admins and Co Admins" in the brief is
 * this same set, so it's reused rather than re-implemented.
 */
function canScheduleMeeting(user, project) {
  return canManageProject(user, project);
}

/**
 * Anyone who is a project member but not scheduler-eligible (i.e.
 * Contributors/Viewers) can request a meeting instead of scheduling one
 * directly. GUEST is read-only by design and never qualifies, even if
 * somehow listed as a project member.
 */
function canRequestMeeting(user, project) {
  if (user.role === ROLES.GUEST) return false;
  if (canScheduleMeeting(user, project)) return false;
  return Boolean(getProjectMemberRole(project, user._id));
}

function isMeetingParticipant(user, meeting) {
  return meeting.participants.some((entry) => isSameId(entry.user, user._id));
}

function isMeetingHost(user, meeting) {
  return isSameId(meeting.host, user._id);
}

/**
 * Meetings aren't visibility-scoped like Tasks — any project member can see
 * that a meeting exists (matches "Meeting appears in Project Meetings" for
 * the whole project, not just invitees).
 */
function canViewMeeting(user, project, meeting) {
  if (!isSameId(user.organization, project.organization)) return false;
  if (isOrgAdmin(user)) return true;
  return Boolean(getProjectMemberRole(project, user._id));
}

/**
 * Update/cancel/end/add-participants/approve-request — scheduler-eligible
 * only, independent of whether they happen to be this specific meeting's
 * host.
 */
function canManageMeeting(user, project, meeting) {
  return canScheduleMeeting(user, project);
}

/**
 * Gates join-token minting: the host, any invited participant, or anyone
 * who could have scheduled the meeting (so a manager can always drop into a
 * project meeting even if not personally invited).
 */
function canJoinMeeting(user, project, meeting) {
  if (!isSameId(user.organization, project.organization)) return false;
  if (isMeetingHost(user, meeting)) return true;
  if (isMeetingParticipant(user, meeting)) return true;
  return canScheduleMeeting(user, project);
}

module.exports = {
  canJoinMeeting,
  canManageMeeting,
  canRequestMeeting,
  canScheduleMeeting,
  canViewMeeting,
  isMeetingHost,
  isMeetingParticipant,
};
