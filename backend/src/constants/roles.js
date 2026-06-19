const ROLES = Object.freeze({
  SUPER_ADMIN: 'super-admin',
  ORGANIZATION_ADMIN: 'organization-admin',
  HR: 'hr',
  MANAGER: 'manager',
  EMPLOYEE: 'employee',
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: ['*'],
  [ROLES.ORGANIZATION_ADMIN]: ['users:read', 'users:write', 'teams:write', 'documents:write', 'reports:read', 'analytics:read'],
  [ROLES.HR]: ['employees:read', 'employees:write', 'assets:read', 'assets:write'],
  [ROLES.MANAGER]: ['projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'meetings:read', 'meetings:write', 'reports:read'],
  [ROLES.EMPLOYEE]: ['projects:read', 'tasks:read', 'tasks:write', 'documents:read', 'meetings:read'],
});

module.exports = { ROLES, ROLE_PERMISSIONS };