const bcrypt = require('bcrypt');
const env = require('../config/env');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const {
  createRefreshTokenRecord,
  createRefreshTokenFamilyId,
  createSession,
  findRefreshTokenRecordByHash,
  listSessionsForUser,
  refreshTokenHash,
  revokeAllSessionsForUser,
  revokeRefreshTokenByHash,
  revokeSession,
  updateSessionLastSeen,
} = require('./session.service');
const { issueTokenPair, persistRefreshToken, refreshTokenHash: hashRefreshJti, parseJwtTtl } = require('./token.service');
const { withResolvedStatus } = require('./presence.service');
const { getRequestContext } = require('../utils/device');
const { logAudit } = require('./audit.service');
const { sendOtpEmail, sendPasswordResetEmail } = require('./email.service');
const { storeEmailOtp, verifyEmailOtp, invalidateEmailOtp } = require('./otp.service');
const {
  createPasswordResetToken,
  verifyPasswordResetToken,
  revokePasswordResetToken,
} = require('./password-reset.service');
const { verifyRefreshToken, verifyAccessToken } = require('../utils/jwt');

const PASSWORD_SALT_ROUNDS = 12;

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function findUserByEmail(email, includePassword = false) {
  const query = User.findOne({ email: normalizeEmail(email) });
  if (includePassword) {
    query.select('+passwordHash');
  }
  return query;
}

function buildPasswordHash(password) {
  return bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
}

async function registerUser({ firstName, lastName, email, password, req }) {
  const normalizedEmail = normalizeEmail(email);
  const existingUser = await findUserByEmail(normalizedEmail);

  if (existingUser) {
    throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await buildPasswordHash(password);
  const user = await User.create({
    email: normalizedEmail,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    passwordHash,
  });

  const otp = await storeEmailOtp(normalizedEmail);
  await sendOtpEmail({
    firstName: user.firstName,
    otp,
    to: user.email,
  });

  await logAudit({
    action: AUDIT_EVENTS.USER_REGISTERED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email },
    req,
    success: true,
    userId: user._id,
  });

  return {
    message: 'Registration successful. Verify your email using the OTP sent to your inbox.',
    user: user.toSafeObject(),
  };
}

async function verifyEmailWithOtp({ email, otp, req }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    throw new AppError('Invalid verification request', 400, 'INVALID_OTP');
  }

  const otpValid = await verifyEmailOtp(normalizedEmail, otp);
  if (!otpValid) {
    throw new AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
  }

  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  await user.save();
  await invalidateEmailOtp(normalizedEmail);

  await logAudit({
    action: AUDIT_EVENTS.EMAIL_OTP_VERIFIED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email },
    req,
    success: true,
    userId: user._id,
  });

  return { message: 'Email verified successfully', user: user.toSafeObject() };
}

async function resendVerificationOtp({ email, req }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    return { message: 'If the account exists, a new verification OTP has been sent.' };
  }

  if (user.emailVerified) {
    throw new AppError('Email is already verified', 409, 'EMAIL_ALREADY_VERIFIED');
  }

  const otp = await storeEmailOtp(normalizedEmail);
  await sendOtpEmail({
    firstName: user.firstName,
    otp,
    to: user.email,
  });

  await logAudit({
    action: AUDIT_EVENTS.EMAIL_OTP_SENT,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email },
    req,
    success: true,
    userId: user._id,
  });

  return { message: 'Verification OTP sent' };
}

async function authenticateWithPassword(user, password) {
  return bcrypt.compare(password, user.passwordHash);
}

function applyAccountLock(user) {
  user.failedLoginAttempts += 1;
  if (user.failedLoginAttempts >= AUTH_CONSTANTS.ACCOUNT_LOCK_ATTEMPTS) {
    user.lockUntil = new Date(Date.now() + AUTH_CONSTANTS.ACCOUNT_LOCK_DURATION_MS);
  }
}

function clearAccountLockState(user) {
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
}

async function loginUser({ email, password, req }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail, true);

  if (!user || !user.isActive) {
    await logAudit({
      action: AUDIT_EVENTS.LOGIN_FAILED,
      entityType: 'user',
      metadata: { email: normalizedEmail },
      req,
      success: false,
    });

    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  if (user.isLocked()) {
    throw new AppError('Account is temporarily locked. Try again later.', 423, 'ACCOUNT_LOCKED');
  }

  const passwordMatch = await authenticateWithPassword(user, password);
  if (!passwordMatch) {
    applyAccountLock(user);
    await user.save();

    await logAudit({
      action: AUDIT_EVENTS.LOGIN_FAILED,
      entityId: user._id.toString(),
      entityType: 'user',
      metadata: { email: user.email, failedLoginAttempts: user.failedLoginAttempts },
      req,
      success: false,
      userId: user._id,
    });

    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  if (!user.emailVerified) {
    throw new AppError('Please verify your email before logging in', 403, 'EMAIL_NOT_VERIFIED');
  }

  clearAccountLockState(user);
  user.lastLoginAt = new Date();
  await user.save();

  const requestContext = getRequestContext(req);
  const session = await createSession({
    refreshTokenHash: null,
    refreshTokenId: null,
    requestContext,
    user,
  });

  const issued = issueTokenPair({ session, user });
  const refreshRecord = await persistRefreshToken({
    familyId: issued.familyId,
    refreshJti: issued.refreshJti,
    refreshTokenExpiry: issued.refreshTokenExpiry,
    session,
    user,
  });

  session.refreshToken = refreshRecord._id;
  session.refreshTokenHash = hashRefreshJti(issued.refreshJti);
  await session.save();

  await logAudit({
    action: AUDIT_EVENTS.LOGIN_SUCCEEDED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { sessionId: session._id.toString() },
    req,
    success: true,
    userId: user._id,
  });

  return {
    csrfToken: issued.csrfToken,
    refreshToken: issued.refreshToken,
    session,
    user: await withResolvedStatus(user),
    accessToken: issued.accessToken,
  };
}

async function refreshAuthTokens({ refreshToken, req }) {
  if (!refreshToken) {
    throw new AppError('Refresh token is required', 401, 'MISSING_REFRESH_TOKEN');
  }

  const decoded = verifyRefreshToken(refreshToken);
  const jtiHash = hashRefreshJti(decoded.jti);
  const tokenRecord = await findRefreshTokenRecordByHash(jtiHash);

  if (!tokenRecord || tokenRecord.revokedAt) {
    if (decoded.sub) {
      await revokeAllSessionsForUser(decoded.sub, 'refresh_token_reuse');
    }
    throw new AppError('Refresh token is invalid or has been revoked', 401, 'INVALID_REFRESH_TOKEN');
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive || user.tokenVersion !== decoded.tv) {
    await revokeAllSessionsForUser(decoded.sub, 'token_version_mismatch');
    throw new AppError('Refresh token is invalid', 401, 'INVALID_REFRESH_TOKEN');
  }

  const session = await require('../models/Session').findById(decoded.sid);
  if (!session || !session.isActive || String(session.user) !== String(user._id)) {
    await revokeAllSessionsForUser(user._id, 'session_invalid');
    throw new AppError('Refresh token is invalid', 401, 'INVALID_REFRESH_TOKEN');
  }

  const issued = issueTokenPair({
    familyId: decoded.fam,
    session,
    user,
  });

  const newRecord = await persistRefreshToken({
    familyId: decoded.fam,
    refreshJti: issued.refreshJti,
    refreshTokenExpiry: issued.refreshTokenExpiry,
    session,
    user,
  });

  await revokeRefreshTokenByHash(jtiHash, 'rotated', hashRefreshJti(issued.refreshJti));
  session.refreshToken = newRecord._id;
  session.refreshTokenHash = hashRefreshJti(issued.refreshJti);
  await updateSessionLastSeen(session._id);
  await session.save();

  await logAudit({
    action: AUDIT_EVENTS.TOKEN_REFRESHED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { sessionId: session._id.toString() },
    req,
    success: true,
    userId: user._id,
  });

  return {
    csrfToken: issued.csrfToken,
    refreshToken: issued.refreshToken,
    session,
    user: await withResolvedStatus(user),
    accessToken: issued.accessToken,
  };
}

async function revokeCurrentDevice({ refreshToken, accessToken, req }) {
  let decodedAccess = null;
  let decodedRefresh = null;

  if (accessToken) {
    try {
      decodedAccess = verifyAccessToken(accessToken);
    } catch (error) {
      decodedAccess = null;
    }
  }

  if (refreshToken) {
    try {
      decodedRefresh = verifyRefreshToken(refreshToken);
    } catch (error) {
      decodedRefresh = null;
    }
  }

  const sessionId = decodedAccess?.sid || decodedRefresh?.sid;
  const userId = decodedAccess?.sub || decodedRefresh?.sub;
  const refreshJti = decodedRefresh?.jti;

  if (refreshJti) {
    await revokeRefreshTokenByHash(hashRefreshJti(refreshJti), 'logout_current');
  }

  if (sessionId) {
    await revokeSession(sessionId, 'logout_current');
  }

  if (userId) {
    await logAudit({
      action: AUDIT_EVENTS.LOGOUT_CURRENT,
      entityId: userId,
      entityType: 'user',
      metadata: { sessionId },
      req,
      success: true,
      userId,
    });
  }

  return { message: 'Logged out successfully' };
}

async function revokeAllDevices({ userId, req }) {
  const user = await User.findById(userId);
  if (!user) {
    return { message: 'Logged out successfully' };
  }

  user.tokenVersion += 1;
  await user.save();
  await revokeAllSessionsForUser(user._id, 'logout_all');

  await logAudit({
    action: AUDIT_EVENTS.LOGOUT_ALL,
    entityId: user._id.toString(),
    entityType: 'user',
    req,
    success: true,
    userId: user._id,
  });

  return { message: 'Logged out from all devices' };
}

async function requestPasswordReset({ email, req }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    return { message: 'If the account exists, a password reset email has been sent.' };
  }

  const resetToken = await createPasswordResetToken(normalizedEmail);
  const resetUrl = `${env.CLIENT_URL}/reset-password?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(resetToken)}`;

  await sendPasswordResetEmail({
    firstName: user.firstName,
    resetUrl,
    to: user.email,
  });

  await logAudit({
    action: AUDIT_EVENTS.PASSWORD_RESET_REQUESTED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email },
    req,
    success: true,
    userId: user._id,
  });

  return { message: 'If the account exists, a password reset email has been sent.' };
}

async function resetPassword({ email, password, token, req }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail, true);

  if (!user) {
    throw new AppError('Invalid password reset request', 400, 'INVALID_RESET_TOKEN');
  }

  const validResetToken = await verifyPasswordResetToken(normalizedEmail, token);
  if (!validResetToken) {
    throw new AppError('Invalid or expired reset token', 400, 'INVALID_RESET_TOKEN');
  }

  user.passwordHash = await buildPasswordHash(password);
  user.passwordChangedAt = new Date();
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  user.tokenVersion += 1;
  await user.save();
  await revokeAllSessionsForUser(user._id, 'password_reset');
  await revokePasswordResetToken(normalizedEmail);

  await logAudit({
    action: AUDIT_EVENTS.PASSWORD_RESET_COMPLETED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email },
    req,
    success: true,
    userId: user._id,
  });

  return { message: 'Password updated successfully' };
}

async function getProfile(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  return withResolvedStatus(user);
}

async function updateProfile({ userId, changes, req }) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  const before = {};
  for (const key of ['firstName', 'lastName', 'skills']) {
    if (changes[key] === undefined) continue;
    before[key] = user[key];
    user[key] = changes[key];
  }
  await user.save();
  await logAudit({ action: AUDIT_EVENTS.PROFILE_UPDATED, entityId: user._id.toString(), entityType: 'user', metadata: { fields: Object.keys(before) }, req, success: true, userId: user._id, organizationId: user.organization });
  return withResolvedStatus(user);
}

/**
 * Authenticated password change. Requires the current password (a stolen access token alone is not enough), counts failures like a login
 * (same lockout), and signs the account out everywhere, exactly like a password reset, so every session must log in again.
 */
async function changePassword({ userId, currentPassword, newPassword, req }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
    throw new AppError('Account is temporarily locked. Try again later', 423, 'ACCOUNT_LOCKED');
  }
  if (!(await authenticateWithPassword(user, currentPassword))) {
    applyAccountLock(user);
    await user.save();
    await logAudit({ action: AUDIT_EVENTS.PASSWORD_CHANGED, entityId: user._id.toString(), entityType: 'user', req, success: false, userId: user._id });
    throw new AppError('Your current password is incorrect', 400, 'INVALID_CURRENT_PASSWORD');
  }
  user.passwordHash = await buildPasswordHash(newPassword);
  user.passwordChangedAt = new Date();
  clearAccountLockState(user);
  user.tokenVersion += 1;
  await user.save();
  await revokeAllSessionsForUser(user._id, 'password_changed');
  await logAudit({ action: AUDIT_EVENTS.PASSWORD_CHANGED, entityId: user._id.toString(), entityType: 'user', req, success: true, userId: user._id });
  return { message: 'Password changed. Please sign in again' };
}

async function getSessions(userId) {
  return listSessionsForUser(userId);
}

async function revokeDeviceSession({ userId, sessionId, req }) {
  const session = await require('../models/Session').findOne({ _id: sessionId, user: userId });

  if (!session) {
    throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
  }

  await revokeSession(session._id, 'revoked_by_user');

  await logAudit({
    action: AUDIT_EVENTS.SESSION_REVOKED,
    entityId: String(session._id),
    entityType: 'session',
    metadata: { userId: String(userId) },
    req,
    success: true,
    userId,
  });

  return { message: 'Session revoked successfully' };
}

function issueCsrfToken() {
  return require('../utils/crypto').generateRandomToken(24);
}

module.exports = {
  changePassword,
  updateProfile,
  getProfile,
  getSessions,
  issueCsrfToken,
  loginUser,
  refreshAuthTokens,
  registerUser,
  requestPasswordReset,
  resendVerificationOtp,
  resetPassword,
  revokeCurrentDevice,
  revokeDeviceSession,
  revokeAllDevices,
  verifyEmailWithOtp,
};