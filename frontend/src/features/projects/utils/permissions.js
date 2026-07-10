// Mirrors backend/src/utils/projectAccess.js#canManageProject — used only to
// decide which actions to show; the backend re-checks authoritatively on
// every request, so a stale/optimistic result here is never a security issue.
export function canManageProjectClient(project, authUser) {
  if (!project || !authUser) return false;
  if (authUser.role === "ORG_ADMIN" || authUser.role === "ADMIN") return true;
  if (project.myRole === "Owner" || project.myRole === "Manager") return true;
  if (authUser.role === "MANAGER" && authUser.team && project.team && authUser.team === project.team) return true;
  return false;
}
