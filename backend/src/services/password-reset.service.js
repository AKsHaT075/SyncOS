const { createRedisClient } = require('../config/redis');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { generateRandomToken, sha256 } = require('../utils/crypto');

function resetKey(email) {
  return `${AUTH_CONSTANTS.PASSWORD_RESET_PREFIX}${String(email).toLowerCase()}`;
}

async function createPasswordResetToken(email) {
  const redis = createRedisClient();
  const token = generateRandomToken(32);
  await redis.setEx(resetKey(email), AUTH_CONSTANTS.PASSWORD_RESET_TTL_SECONDS, sha256(token));
  return token;
}

async function verifyPasswordResetToken(email, token) {
  const redis = createRedisClient();
  const storedHash = await redis.get(resetKey(email));
  if (!storedHash) {
    return false;
  }

  const match = storedHash === sha256(token);
  if (match) {
    await redis.del(resetKey(email));
  }

  return match;
}

async function revokePasswordResetToken(email) {
  const redis = createRedisClient();
  await redis.del(resetKey(email));
}

module.exports = {
  createPasswordResetToken,
  revokePasswordResetToken,
  verifyPasswordResetToken,
};