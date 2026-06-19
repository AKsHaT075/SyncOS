const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  limit: 10,
  message: { message: 'Too many auth requests. Please try again later.' },
  standardHeaders: true,
  windowMs: 15 * 60 * 1000,
});

const otpLimiter = rateLimit({
  limit: 5,
  message: { message: 'Too many OTP requests. Please try again later.' },
  standardHeaders: true,
  windowMs: 15 * 60 * 1000,
});

const passwordResetLimiter = rateLimit({
  limit: 5,
  message: { message: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  windowMs: 15 * 60 * 1000,
});

const apiLimiter = rateLimit({
  limit: 300,
  message: { message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  windowMs: 15 * 60 * 1000,
});

module.exports = {
  apiLimiter,
  authLimiter,
  otpLimiter,
  passwordResetLimiter,
};