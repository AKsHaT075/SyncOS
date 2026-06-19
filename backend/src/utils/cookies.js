const env = require('../config/env');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');

function baseCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}

function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
  res.cookie(AUTH_CONSTANTS.ACCESS_TOKEN_COOKIE, accessToken, baseCookieOptions(15 * 60 * 1000));
  res.cookie(AUTH_CONSTANTS.REFRESH_TOKEN_COOKIE, refreshToken, baseCookieOptions(7 * 24 * 60 * 60 * 1000));

  if (csrfToken) {
    res.cookie(AUTH_CONSTANTS.CSRF_TOKEN_COOKIE, csrfToken, {
      ...baseCookieOptions(7 * 24 * 60 * 60 * 1000),
      httpOnly: false,
    });
  }
}

function clearAuthCookies(res) {
  const clearOptions = {
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
  };

  res.clearCookie(AUTH_CONSTANTS.ACCESS_TOKEN_COOKIE, clearOptions);
  res.clearCookie(AUTH_CONSTANTS.REFRESH_TOKEN_COOKIE, clearOptions);
  res.clearCookie(AUTH_CONSTANTS.CSRF_TOKEN_COOKIE, clearOptions);
}

function getCookieToken(req, cookieName) {
  return req.cookies?.[cookieName] || null;
}

module.exports = {
  clearAuthCookies,
  getCookieToken,
  setAuthCookies,
};