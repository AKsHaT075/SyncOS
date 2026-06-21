const AppError = require('../utils/app-error');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');

function checkPermission(permission) {
  return function checkPermissionMiddleware(req, res, next) {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
    }

    const permissions = ROLE_PERMISSIONS[req.user.role] || [];
    if (!permissions.includes(permission)) {
      return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
    }

    return next();
  };
}

module.exports = checkPermission;
