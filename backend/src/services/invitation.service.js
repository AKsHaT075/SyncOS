const bcrypt = require('bcrypt');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { AUTH_CONSTANTS } = require('../constants/auth.constants');
const { ROLES } = require('../constants/roles');
const { generateRandomToken, sha256 } = require('../utils/crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Invitation = require('../models/Invitation');
const { sendInvitationEmail } = require('./email.service');
const { logAudit } = require('./audit.service');

const PASSWORD_SALT_ROUNDS = 12;

/**
 * ORG_ADMIN (the org owner) may invite into any of these roles, including
 * ADMIN. ADMIN carries the same day-to-day permissions as ORG_ADMIN but may
 * NOT invite or promote another ADMIN — only the owner grants that tier.
 */
function getInvitableRoles(inviterRole) {
  if (inviterRole === ROLES.ORG_ADMIN) {
    return [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE];
  }

  return [ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE];
}

function newExpiry() {
  return new Date(Date.now() + AUTH_CONSTANTS.INVITE_TTL_SECONDS * 1000);
}

async function sendInviteEmail({ token, email, organization, role }) {
  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/accept?token=${token}`;
  await sendInvitationEmail({ to: email, organizationName: organization.name, role, inviteUrl });
}

async function inviteUser({ email, role, inviter, req }) {
  if (!inviter.organization) {
    throw new AppError('You must belong to an organization to invite users', 400, 'NO_ORGANIZATION');
  }

  if (!getInvitableRoles(inviter.role).includes(role)) {
    throw new AppError('You cannot invite a user with this role', 403, 'INVALID_INVITE_ROLE');
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
  }

  const existingPendingInvite = await Invitation.findOne({
    organization: inviter.organization,
    email: normalizedEmail,
    status: 'pending',
  });
  if (existingPendingInvite && existingPendingInvite.effectiveStatus() === 'pending') {
    throw new AppError('An invitation is already pending for this email', 409, 'INVITE_ALREADY_PENDING');
  }

  const organization = await Organization.findById(inviter.organization);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  const token = generateRandomToken(32);
  const invitation = await Invitation.create({
    organization: organization._id,
    email: normalizedEmail,
    role,
    invitedBy: inviter._id,
    tokenHash: sha256(token),
    expiresAt: newExpiry(),
  });

  await sendInviteEmail({ token, email: normalizedEmail, organization, role });

  await logAudit({
    action: AUDIT_EVENTS.USER_INVITED,
    entityId: invitation._id.toString(),
    entityType: 'invitation',
    metadata: { email: normalizedEmail, role },
    organizationId: organization._id,
    req,
    userId: inviter._id,
  });

  return { message: 'Invitation sent successfully' };
}

async function acceptInvitation({ token, firstName, lastName, password, req }) {
  const invitation = await Invitation.findOne({ tokenHash: sha256(token) });

  if (!invitation || invitation.effectiveStatus() !== 'pending') {
    throw new AppError('Invitation is invalid or has expired', 400, 'INVALID_INVITE');
  }

  const existingUser = await User.findOne({ email: invitation.email });
  if (existingUser) {
    throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
  const user = await User.create({
    email: invitation.email,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    passwordHash,
    organization: invitation.organization,
    role: invitation.role,
    emailVerified: true,
    emailVerifiedAt: new Date(),
  });

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = user._id;
  await invitation.save();

  await logAudit({
    action: AUDIT_EVENTS.INVITE_ACCEPTED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email, role: user.role, invitedBy: invitation.invitedBy.toString() },
    organizationId: invitation.organization,
    req,
    userId: user._id,
  });

  return { user: user.toSafeObject() };
}

async function acceptInvitationForExistingUser({ token, user, req }) {
  if (user.organization) {
    throw new AppError('You already belong to an organization', 409, 'ALREADY_IN_ORGANIZATION');
  }

  const invitation = await Invitation.findOne({ tokenHash: sha256(token) });
  if (!invitation || invitation.effectiveStatus() !== 'pending') {
    throw new AppError('Invitation is invalid or has expired', 400, 'INVALID_INVITE');
  }

  if (invitation.email !== user.email) {
    throw new AppError('This invitation was sent to a different email address', 400, 'EMAIL_MISMATCH');
  }

  user.organization = invitation.organization;
  user.role = invitation.role;
  await user.save();

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = user._id;
  await invitation.save();

  await logAudit({
    action: AUDIT_EVENTS.INVITE_ACCEPTED,
    entityId: user._id.toString(),
    entityType: 'user',
    metadata: { email: user.email, role: user.role, invitedBy: invitation.invitedBy.toString() },
    organizationId: invitation.organization,
    req,
    userId: user._id,
  });

  return { user: user.toSafeObject() };
}

async function listInvitations({ organization, status, page = 1, limit = 20 }) {
  const query = { organization };

  if (status === 'expired') {
    query.status = 'pending';
    query.expiresAt = { $lt: new Date() };
  } else if (status) {
    query.status = status;
    if (status === 'pending') {
      query.expiresAt = { $gte: new Date() };
    }
  }

  const skip = (page - 1) * limit;
  const [invitations, total] = await Promise.all([
    Invitation.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Invitation.countDocuments(query),
  ]);

  return {
    invitations: invitations.map((invitation) => invitation.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function resendInvitation({ invitationId, organization, inviter, req }) {
  const invitation = await Invitation.findOne({ _id: invitationId, organization });
  if (!invitation) {
    throw new AppError('Invitation not found', 404, 'NOT_FOUND');
  }

  if (invitation.status === 'accepted') {
    throw new AppError('This invitation has already been accepted', 409, 'INVITE_ALREADY_ACCEPTED');
  }

  const organizationDoc = await Organization.findById(organization);
  const token = generateRandomToken(32);

  invitation.status = 'pending';
  invitation.tokenHash = sha256(token);
  invitation.expiresAt = newExpiry();
  invitation.revokedAt = null;
  invitation.revokedBy = null;
  await invitation.save();

  await sendInviteEmail({ token, email: invitation.email, organization: organizationDoc, role: invitation.role });

  await logAudit({
    action: AUDIT_EVENTS.INVITE_RESENT,
    entityId: invitation._id.toString(),
    entityType: 'invitation',
    metadata: { email: invitation.email, role: invitation.role },
    organizationId: organization,
    req,
    userId: inviter._id,
  });

  return { invitation: invitation.toSafeObject() };
}

async function revokeInvitation({ invitationId, organization, inviter, req }) {
  const invitation = await Invitation.findOne({ _id: invitationId, organization });
  if (!invitation) {
    throw new AppError('Invitation not found', 404, 'NOT_FOUND');
  }

  if (invitation.status === 'accepted') {
    throw new AppError('This invitation has already been accepted', 409, 'INVITE_ALREADY_ACCEPTED');
  }

  invitation.status = 'revoked';
  invitation.revokedAt = new Date();
  invitation.revokedBy = inviter._id;
  await invitation.save();

  await logAudit({
    action: AUDIT_EVENTS.INVITE_REVOKED,
    entityId: invitation._id.toString(),
    entityType: 'invitation',
    metadata: { email: invitation.email, role: invitation.role },
    organizationId: organization,
    req,
    userId: inviter._id,
  });

  return { invitation: invitation.toSafeObject() };
}

module.exports = {
  acceptInvitation,
  acceptInvitationForExistingUser,
  getInvitableRoles,
  inviteUser,
  listInvitations,
  resendInvitation,
  revokeInvitation,
};
