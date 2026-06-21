const { ROLES } = require('../constants/roles');

/**
 * Managers may manage (and delete) any project within their organization;
 * org admins may manage the entire organization. No other role may delete
 * a project.
 */
function canDeleteProject(user, project) {
  if (!user.organization || project.organization.toString() !== user.organization.toString()) {
    return false;
  }

  return user.role === ROLES.ORG_ADMIN || user.role === ROLES.MANAGER;
}

module.exports = canDeleteProject;
