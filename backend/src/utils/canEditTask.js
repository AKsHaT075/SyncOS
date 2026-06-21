const { ROLES } = require('../constants/roles');

/**
 * Employees may only edit tasks assigned to them. Managers and org admins
 * may edit any task within their own organization.
 */
function canEditTask(user, task) {
  if (!user.organization || task.organization.toString() !== user.organization.toString()) {
    return false;
  }

  if (user.role === ROLES.ORG_ADMIN || user.role === ROLES.MANAGER) {
    return true;
  }

  if (user.role === ROLES.EMPLOYEE) {
    return Boolean(task.assignedTo) && task.assignedTo.toString() === user._id.toString();
  }

  return false;
}

module.exports = canEditTask;
