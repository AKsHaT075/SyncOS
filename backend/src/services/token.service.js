const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { generateRandomToken, sha256 } = require('../utils/crypto');
const { signAccessToken, signRefreshToken } = require('../utils/jwt');
const { createRefreshTokenRecord, createRefreshTokenFamilyId, refreshTokenHash } = require('./session.service');

function parseJwtTtl(ttl) {
  const match = String(ttl).match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(`Unsupported token ttl: ${ttl}`);
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

function buildAccessPayload(user, session) {
  return {
    sid: session._id.toString(),
    sub: user._id.toString(),
    tv: user.tokenVersion,
    role: user.role,
  };
}

function buildRefreshPayload(user, session, familyId) {
  return {
    fam: familyId,
    sid: session._id.toString(),
    sub: user._id.toString(),
    tv: user.tokenVersion,
  };
}

function issueTokenPair({ user, session, familyId = createRefreshTokenFamilyId() }) {
  const accessToken = signAccessToken(buildAccessPayload(user, session));
  const refreshJti = generateRandomToken(16);
  const refreshToken = signRefreshToken(buildRefreshPayload(user, session, familyId), refreshJti);
  const csrfToken = generateRandomToken(24);

  return {
    accessToken,
    csrfToken,
    familyId,
    refreshHash: sha256(refreshJti),
    refreshJti,
    refreshToken,
    refreshTokenExpiry: new Date(Date.now() + parseJwtTtl(AUTH_CONSTANTS.REFRESH_TOKEN_TTL)),
  };
}

async function persistRefreshToken({ user, session, familyId, refreshJti, refreshTokenExpiry }) {
  return createRefreshTokenRecord({
    expiresAt: refreshTokenExpiry,
    familyId,
    jtiHash: sha256(refreshJti),
    sessionId: session._id,
    userId: user._id,
  });
}

module.exports = {
  buildAccessPayload,
  issueTokenPair,
  persistRefreshToken,
  refreshTokenHash,
  parseJwtTtl,
};