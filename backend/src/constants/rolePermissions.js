const { ROLES } = require('./roles');
const { PERMISSIONS } = require('./permissions');

/**
 * SUPER_ADMIN intentionally has no entries here: they administer the
 * platform (organizations themselves), not the data inside an organization.
 * Per-organization access for a super admin must go through an explicit,
 * audited elevation path rather than this map.
 */
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: [],

  [ROLES.ORG_ADMIN]: Object.values(PERMISSIONS),

  [ROLES.HR]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.UPLOAD_DOCUMENT,
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.CREATE_TEAM,
    PERMISSIONS.UPDATE_TEAM,
  ],

  [ROLES.MANAGER]: [
    PERMISSIONS.CREATE_PROJECT,
    PERMISSIONS.UPDATE_PROJECT,
    PERMISSIONS.DELETE_PROJECT,
    PERMISSIONS.CREATE_TASK,
    PERMISSIONS.UPDATE_TASK,
    PERMISSIONS.DELETE_TASK,
    PERMISSIONS.ASSIGN_TASK,
    PERMISSIONS.CREATE_MEETING,
    PERMISSIONS.UPDATE_MEETING,
    PERMISSIONS.UPLOAD_DOCUMENT,
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.CREATE_TEAM,
    PERMISSIONS.UPDATE_TEAM,
    PERMISSIONS.MANAGE_ASSETS,
  ],

  [ROLES.EMPLOYEE]: [PERMISSIONS.UPDATE_TASK, PERMISSIONS.UPLOAD_DOCUMENT],

  [ROLES.GUEST]: [],
});

module.exports = { ROLE_PERMISSIONS };
