const AppError = require('../utils/app-error');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { timingSafeEqual } = require('../utils/crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/resend-otp',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/csrf-token',
  '/health',
];

function isExemptPath(pathname) {
  return EXEMPT_PATHS.some((path) => pathname.startsWith(path));
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method) || isExemptPath(req.path)) {
    return next();
  }

  const cookieToken = req.cookies?.[AUTH_CONSTANTS.CSRF_TOKEN_COOKIE];
  const headerToken = req.get('x-csrf-token') || req.get('x-xsrf-token');

  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return next(new AppError('CSRF validation failed', 403, 'CSRF_VALIDATION_FAILED'));
  }

  return next();
}

module.exports = csrfProtection;