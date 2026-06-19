const AppError = require('../utils/app-error');
const { ROLE_PERMISSIONS } = require('../constants/roles');

function requireRole(...allowedRoles) {
  return function roleMiddleware(req, res, next) {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
    }

    return next();
  };
}

function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
    }

    const permissions = ROLE_PERMISSIONS[req.user.role] || [];
    if (!permissions.includes('*') && !permissions.includes(permission)) {
      return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
    }

    return next();
  };
}

module.exports = {
  requirePermission,
  requireRole,
};