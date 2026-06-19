const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateRandomToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function generateNumericOtp(length = 6) {
  const max = 10 ** length;
  return String(Math.floor(Math.random() * max)).padStart(length, '0');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  generateNumericOtp,
  generateRandomToken,
  sha256,
  timingSafeEqual,
};