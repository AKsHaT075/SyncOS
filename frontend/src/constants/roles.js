// Mirrors backend/src/constants/roles.js — keep these string values in sync.
export const ROLES = Object.freeze({
  SUPER_ADMIN: "super-admin",
  ORG_ADMIN: "org-admin",
  ADMIN: "admin",
  HR: "hr",
  MANAGER: "manager",
  EMPLOYEE: "employee",
  GUEST: "guest",
});

// Mirrors backend/src/validations/people.validation.js ASSIGNABLE_ROLES —
// SUPER_ADMIN is a platform role and ORG_ADMIN is the org owner, neither is
// assignable through the people directory's role-change action.
export const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST];

// Org Admin is the org owner — call it out with the app's violet accent
// wherever a role is shown as plain text (People table/grid, profile header).
export const ORG_ADMIN_TEXT_CLASS = "text-violet-600 font-semibold";
export const ORG_ADMIN_BADGE_CLASS = "border-violet-200 bg-violet-50 text-violet-600";
