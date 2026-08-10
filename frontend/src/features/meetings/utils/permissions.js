import { ROLES } from "@/constants/roles";

// Mirrors backend/src/utils/meetingAccess.js — used only to decide which
// actions to show; the backend re-checks authoritatively on every request.
function isOrgAdmin(authUser) {
  return authUser?.role === ROLES.ORG_ADMIN || authUser?.role === ROLES.ADMIN;
}

// canScheduleMeeting on the backend === canManageProject, which the Project
// detail page already surfaces as `project.myRole` — reuse that instead of
// re-deriving org-role/team-match logic on the client.
export function canScheduleMeetingClient(project, authUser) {
  if (isOrgAdmin(authUser)) return true;
  if (project?.myRole === "Owner" || project?.myRole === "Manager") return true;
  return authUser?.role === ROLES.MANAGER && Boolean(authUser?.team) && authUser.team === project?.team;
}

export function canRequestMeetingClient(project, authUser) {
  if (authUser?.role === ROLES.GUEST) return false;
  if (canScheduleMeetingClient(project, authUser)) return false;
  return Boolean(project?.myRole);
}

export function canManageMeetingClient(project, authUser) {
  return canScheduleMeetingClient(project, authUser);
}
