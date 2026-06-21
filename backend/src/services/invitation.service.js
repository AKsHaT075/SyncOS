const bcrypt = require('bcrypt');
const { createRedisClient } = require('../config/redis');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { ROLES } = require('../constants/roles');
const { generateRandomToken, sha256 } = require('../utils/crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { sendInvitationEmail } = require('./email.service');
const { logAudit } = require('./audit.service');

const PASSWORD_SALT_ROUNDS = 12;
const INVITABLE_ROLES = [ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE];

function inviteKey(token) {
  return `${AUTH_CONSTANTS.INVITE_PREFIX}${sha256(token)}`;
}

async function inviteUser({ email, role, inviter, req }) {
  if (!inviter.organization) {
    throw new AppError('You must belong to an organization to invite users', 400, 'NO_ORGANIZATION');
  }

  if (!INVITABLE_ROLES.includes(role)) {
    throw new AppError('You cannot invite a user with this role', 403, 'INVALID_INVITE_ROLE');
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
  }

  const organization = await Organization.findById(inviter.organization);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  const token = generateRandomToken(32);
  const redis = createRedisClient();
  await redis.setEx(
    inviteKey(token),
    AUTH_CONSTANTS.INVITE_TTL_SECONDS,
    JSON.stringify({
      email: normalizedEmail,
      role,
      organization: organization._id.toString(),
      invitedBy: inviter._id.toString(),
    })
  );

  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/accept?token=${token}`;
  await sendInvitationEmail({ to: normalizedEmail, organizationName: organization.name, role, inviteUrl });

  await logAudit({
    action: AUDIT_EVENTS.USER_INVITED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    metadata: { email: normalizedEmail, role },
    req,
    userId: inviter._id,
  });

  return { message: 'Invitation sent successfully' };
}

async function acceptInvitation({ token, firstName, lastName, password, req }) {
  const redis = createRedisClient();
  const key = inviteKey(token);
  const raw = await redis.get(key);

  if (!raw) {
    throw new AppError('Invitation is invalid or has expired', 400, 'INVALID_INVITE');
  }

  const invite = JSON.parse(raw);

  const existingUser = await User.findOne({ email: invite.email });
  if (existingUser) {
    await redis.del(key);
    throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
  const user = await User.create({
    email: invite.email,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    passwordHash,
    organization: invite.organization,
    role: invite.role,
    emailVerified: true,
    emailVerifiedAt: new Date(),
  });

  await redis.del(key);

  await logAudit({
    action: AUDIT_EVENTS.INVITE_ACCEPTED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email, role: user.role, organization: invite.organization, invitedBy: invite.invitedBy },
    req,
    userId: user._id,
  });

  return { user: user.toSafeObject() };
}

module.exports = {
  acceptInvitation,
  inviteUser,
};
