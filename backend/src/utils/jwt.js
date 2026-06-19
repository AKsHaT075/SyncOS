const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');

function signAccessToken(payload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_TTL });
}

function signRefreshToken(payload, jwtId) {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: AUTH_CONSTANTS.REFRESH_TOKEN_TTL,
    jwtid: jwtId,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};