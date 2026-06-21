const express = require('express');
const { validateBody } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const {
  authLimiter,
  otpLimiter,
  passwordResetLimiter,
} = require('../middlewares/rate-limit.middleware');
const {
  forgotPassword,
  csrfToken,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  resendOtp,
  resetPassword,
  revokeSession,
  sessions,
  verifyEmail,
} = require('../controllers/auth.controller');
const {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  verifyOtpSchema,
} = require('../validations/auth.validation');

const router = express.Router();

router.get('/csrf-token', csrfToken);
router.post('/register', authLimiter, validateBody(registerSchema), register);
router.post('/verify-email', otpLimiter, validateBody(verifyOtpSchema), verifyEmail);
router.post('/resend-otp', otpLimiter, validateBody(resendOtpSchema), resendOtp);
router.post('/login', authLimiter, validateBody(loginSchema), login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/logout-all', authenticate, logoutAll);
router.get('/me', authenticate, me);
router.get('/sessions', authenticate, sessions);
router.delete('/sessions/:sessionId', authenticate, revokeSession);
router.post('/forgot-password', passwordResetLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', passwordResetLimiter, validateBody(resetPasswordSchema), resetPassword);

module.exports = router;