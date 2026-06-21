const AppError = require('../utils/app-error');
const { getCookieToken } = require('../utils/cookies');
const { verifyAccessToken } = require('../utils/jwt');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const User = require('../models/User');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : null;
}

function getAccessToken(req) {
  return getCookieToken(req, AUTH_CONSTANTS.ACCESS_TOKEN_COOKIE) || getBearerToken(req);
}

async function authenticate(req, res, next) {
  const token = getAccessToken(req);
  if (!token) {
    return next(new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
  }

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub);

    if (!user || !user.isActive || user.tokenVersion !== decoded.tv) {
      throw new AppError('Authentication required', 401, 'UNAUTHENTICATED');
    }

    req.auth = decoded;
    req.user = user;
    req.sessionId = decoded.sid;
    return next();
  } catch (error) {
    return next(error instanceof AppError ? error : new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
  }
}

function optionalAuthenticate(req, res, next) {
  const token = getAccessToken(req);
  if (!token) {
    return next();
  }

  try {
    const decoded = verifyAccessToken(token);
    req.auth = decoded;
  } catch (error) {
    // ignore invalid optional auth tokens
  }

  return next();
}

module.exports = {
  authenticate,
  optionalAuthenticate,
};
