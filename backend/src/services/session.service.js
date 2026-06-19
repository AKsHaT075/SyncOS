const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const { generateRandomToken, sha256 } = require('../utils/crypto');

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

async function createSession({ user, requestContext, refreshTokenHash, refreshTokenId }) {
  const expiresAt = new Date(Date.now() + WEEK_IN_MS);

  return Session.create({
    browser: requestContext.browser,
    deviceName: `${requestContext.browser} on ${requestContext.os}`,
    deviceType: requestContext.deviceType,
    expiresAt,
    ipAddress: requestContext.ipAddress,
    isActive: true,
    lastSeenAt: new Date(),
    os: requestContext.os,
    refreshToken: refreshTokenId,
    refreshTokenHash,
    user: user._id,
  });
}

async function updateSessionLastSeen(sessionId) {
  return Session.findByIdAndUpdate(sessionId, { lastSeenAt: new Date() }, { new: true });
}

async function revokeSession(sessionId, reason = 'revoked') {
  const session = await Session.findByIdAndUpdate(
    sessionId,
    { isActive: false, revokedAt: new Date(), revokedReason: reason },
    { new: true }
  );

  if (session) {
    await RefreshToken.updateMany(
      { session: session._id, revokedAt: null },
      { revokedAt: new Date(), revokedReason: reason }
    );
  }

  return session;
}

async function revokeAllSessionsForUser(userId, reason = 'logout_all') {
  const sessions = await Session.find({ user: userId, isActive: true }).select('_id');
  const sessionIds = sessions.map((session) => session._id);

  if (sessionIds.length > 0) {
    await Session.updateMany(
      { _id: { $in: sessionIds } },
      { isActive: false, revokedAt: new Date(), revokedReason: reason }
    );

    await RefreshToken.updateMany(
      { session: { $in: sessionIds }, revokedAt: null },
      { revokedAt: new Date(), revokedReason: reason }
    );
  }

  return sessionIds.length;
}

async function listSessionsForUser(userId) {
  return Session.find({ user: userId }).sort({ lastSeenAt: -1, createdAt: -1 });
}

async function createRefreshTokenRecord({ userId, sessionId, familyId, jtiHash, expiresAt }) {
  return RefreshToken.create({
    expiresAt,
    jtiHash,
    session: sessionId,
    tokenFamilyId: familyId,
    user: userId,
  });
}

async function revokeRefreshTokenByHash(jtiHash, reason = 'rotated', replacedByJtiHash = null) {
  return RefreshToken.findOneAndUpdate(
    { jtiHash },
    {
      revokedAt: new Date(),
      revokedReason: reason,
      replacedByJtiHash,
    },
    { new: true }
  );
}

async function findRefreshTokenRecordByHash(jtiHash) {
  return RefreshToken.findOne({ jtiHash });
}

function createRefreshTokenFamilyId() {
  return generateRandomToken(16);
}

function refreshTokenHash(jti) {
  return sha256(jti);
}

module.exports = {
  createRefreshTokenFamilyId,
  createRefreshTokenRecord,
  createSession,
  findRefreshTokenRecordByHash,
  listSessionsForUser,
  refreshTokenHash,
  revokeAllSessionsForUser,
  revokeRefreshTokenByHash,
  revokeSession,
  updateSessionLastSeen,
};