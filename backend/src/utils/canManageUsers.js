const { ROLES } = require('../constants/roles');

/**
 * Org admins and admins may manage any user in their organization (admin
 * carries the same user-management power as org-admin). HR may manage
 * employees only (not other HR, managers, or admins) — promoting/demoting
 * staff is an org-admin/admin action.
 */
function canManageUsers(user, targetUser) {
  if (!user.organization || targetUser.organization.toString() !== user.organization.toString()) {
    return false;
  }

  if (user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN) {
    return true;
  }

  if (user.role === ROLES.HR) {
    return targetUser.role === ROLES.EMPLOYEE;
  }

  return false;
}

module.exports = canManageUsers;
