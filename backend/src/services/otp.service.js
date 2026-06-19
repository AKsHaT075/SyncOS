const env = require('../config/env');
const { createRedisClient } = require('../config/redis');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { generateNumericOtp, sha256 } = require('../utils/crypto');

function otpKey(email) {
  return `${AUTH_CONSTANTS.EMAIL_OTP_PREFIX}${String(email).toLowerCase()}`;
}

async function storeEmailOtp(email) {
  const redis = createRedisClient();
  const otp = generateNumericOtp(6);
  await redis.setEx(otpKey(email), AUTH_CONSTANTS.EMAIL_OTP_TTL_SECONDS, sha256(otp));
  return otp;
}

async function verifyEmailOtp(email, otp) {
  const redis = createRedisClient();
  const key = otpKey(email);
  const storedHash = await redis.get(key);
  if (!storedHash) {
    return false;
  }

  const match = storedHash === sha256(otp);
  if (match) {
    await redis.del(key);
  }

  return match;
}

async function invalidateEmailOtp(email) {
  const redis = createRedisClient();
  await redis.del(otpKey(email));
}

module.exports = {
  invalidateEmailOtp,
  storeEmailOtp,
  verifyEmailOtp,
};