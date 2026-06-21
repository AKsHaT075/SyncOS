const asyncHandler = require('../utils/async-handler');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { getCookieToken, clearAuthCookies, setAuthCookies } = require('../utils/cookies');
const {
  getProfile,
  getSessions,
  issueCsrfToken,
  loginUser,
  refreshAuthTokens,
  registerUser,
  requestPasswordReset,
  resendVerificationOtp,
  resetPassword,
  revokeAllDevices,
  revokeCurrentDevice,
  revokeDeviceSession,
  verifyEmailWithOtp,
} = require('../services/auth.service');

function setCsrfCookie(res, csrfToken) {
  res.cookie(AUTH_CONSTANTS.CSRF_TOKEN_COOKIE, csrfToken, {
    httpOnly: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

const register = asyncHandler(async (req, res) => {
  const result = await registerUser({ ...req.body, req });
  return res.status(201).json({ success: true, ...result });
});

const verifyEmail = asyncHandler(async (req, res) => {
  const result = await verifyEmailWithOtp({ ...req.body, req });
  return res.status(200).json({ success: true, ...result });
});

const resendOtp = asyncHandler(async (req, res) => {
  const result = await resendVerificationOtp({ ...req.body, req });
  return res.status(200).json({ success: true, ...result });
});

const login = asyncHandler(async (req, res) => {
  const result = await loginUser({ ...req.body, req });
  setAuthCookies(res, result);
  return res.status(200).json({ success: true, accessToken: result.accessToken, user: result.user });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = getCookieToken(req, AUTH_CONSTANTS.REFRESH_TOKEN_COOKIE);
  const result = await refreshAuthTokens({ refreshToken, req });
  setAuthCookies(res, result);
  return res.status(200).json({ success: true, accessToken: result.accessToken, user: result.user });
});

const logout = asyncHandler(async (req, res) => {
  const refreshToken = getCookieToken(req, AUTH_CONSTANTS.REFRESH_TOKEN_COOKIE);
  const accessToken = getCookieToken(req, AUTH_CONSTANTS.ACCESS_TOKEN_COOKIE);
  const result = await revokeCurrentDevice({ accessToken, refreshToken, req });
  clearAuthCookies(res);

  return res.status(200).json({ success: true, ...result });
});

const logoutAll = asyncHandler(async (req, res) => {
  const result = await revokeAllDevices({ req, userId: req.user._id });
  clearAuthCookies(res);

  return res.status(200).json({ success: true, ...result });
});

const me = asyncHandler(async (req, res) => {
  const user = await getProfile(req.user._id);
  return res.status(200).json({ success: true, user });
});

const sessions = asyncHandler(async (req, res) => {
  const sessionsList = await getSessions(req.user._id);
  return res.status(200).json({ success: true, sessions: sessionsList });
});

const revokeSession = asyncHandler(async (req, res) => {
  const result = await revokeDeviceSession({
    req,
    sessionId: req.params.sessionId,
    userId: req.user._id,
  });
  return res.status(200).json({ success: true, ...result });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const result = await requestPasswordReset({ ...req.body, req });
  return res.status(200).json({ success: true, ...result });
});

const resetPasswordHandler = asyncHandler(async (req, res) => {
  const result = await resetPassword({ ...req.body, req });
  return res.status(200).json({ success: true, ...result });
});

const csrfToken = asyncHandler(async (req, res) => {
  const token = issueCsrfToken();
  setCsrfCookie(res, token);
  return res.status(200).json({ success: true, csrfToken: token });
});

module.exports = {
  csrfToken,
  forgotPassword,
  login,
  logout,
  logoutAll,
  me,
  register,
  refresh,
  resendOtp,
  resetPassword: resetPasswordHandler,
  revokeSession,
  sessions,
  verifyEmail,
};