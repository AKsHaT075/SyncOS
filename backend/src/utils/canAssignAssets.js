const { ROLES } = require('../constants/roles');

/**
 * Asset assignment is restricted to org admins, admins, and managers within
 * their own organization (mirrors the MANAGE_ASSETS permission).
 */
function canAssignAssets(user, asset) {
  if (!user.organization || asset.organization.toString() !== user.organization.toString()) {
    return false;
  }

  return user.role === ROLES.ORG_ADMIN || user.role === ROLES.ADMIN || user.role === ROLES.MANAGER;
}

module.exports = canAssignAssets;
