const mongoose = require('mongoose');
const env = require('../config/env');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { ROLES } = require('../constants/roles');
const User = require('../models/User');
const { logAudit } = require('./audit.service');
const teamService = require('./team.service');
const notificationEvents = require('./notificationEvents');
const notificationHub = require('./notificationHub');
const { revokeAllSessionsForUser } = require('./session.service');
const { createPasswordResetToken } = require('./password-reset.service');
const { sendPasswordResetEmail } = require('./email.service');
const { buildPeopleDirectoryFilter, canManageUsers, canViewPerson, serializePerson } = require('../utils/peopleAccess');

/**
 * People directory service.
 *
 * Directory read access and field visibility are enforced by peopleAccess
 * (org role + team membership + activation status). Updates are gated by
 * canManageUsers (ORG_ADMIN / ADMIN / HR). Team changes on a person are
 * delegated to team.service so User.team and the team roster can never
 * drift apart.
 *
 * Role changes, org-blocking, removal, and forced session revocation are
 * further restricted to ORG_ADMIN / ADMIN (HR can manage employee profile
 * fields but not wield these org-level powers), and can never target the
 * acting admin's own account.
 */

const ROLE_ADMIN_ROLES = [ROLES.ORG_ADMIN, ROLES.ADMIN];

// Highest authority first, mirrors the ordering used for team rosters.
const ROLE_RANK = {
  [ROLES.ORG_ADMIN]: 0,
  [ROLES.ADMIN]: 1,
  [ROLES.MANAGER]: 2,
  [ROLES.HR]: 3,
  [ROLES.EMPLOYEE]: 4,
  [ROLES.GUEST]: 5,
};

const ROLE_RANK_EXPR = {
  $switch: {
    branches: Object.entries(ROLE_RANK).map(([role, rank]) => ({
      case: { $eq: ['$role', role] },
      then: rank,
    })),
    default: 99,
  },
};

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findManageableTarget({ userId, actor }) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  const person = await User.findById(userId);
  if (!person || idOf(person.organization) !== idOf(actor.organization)) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  if (!canManageUsers(actor, person)) {
    throw new AppError('You do not have permission to manage this user', 403, 'FORBIDDEN');
  }
  return person;
}

async function listPeople({
  actor,
  search,
  role,
  team,
  sortBy = 'createdAt',
  sortOrder = 'desc',
  page = 1,
  limit = 20,
}) {
  const query = { organization: actor.organization, ...buildPeopleDirectoryFilter(actor) };

  if (role) query.role = role;
  if (team) query.team = team;

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ firstName: regex }, { lastName: regex }];
    if (actor.role !== ROLES.GUEST) {
      query.$or.push({ email: regex });
    }
  }

  const skip = (page - 1) * limit;
  const dir = sortOrder === 'asc' ? 1 : -1;

  let usersPromise;
  if (sortBy === 'role') {
    // Role has no natural alphabetical order that makes sense to a viewer
    // (e.g. "org-admin" would sort after "manager"), so rank by
    // organizational hierarchy instead, same as the team roster.
    usersPromise = User.aggregate([
      { $match: query },
      { $addFields: { roleRank: ROLE_RANK_EXPR } },
      { $sort: { roleRank: dir, firstName: 1, lastName: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'teams', localField: 'team', foreignField: '_id', as: 'teamDoc' } },
      { $unwind: { path: '$teamDoc', preserveNullAndEmptyArrays: true } },
      { $project: { passwordHash: 0 } },
    ]).then((rows) =>
      rows.map((row) => ({
        ...row,
        team: row.teamDoc ? { _id: row.teamDoc._id, name: row.teamDoc.name } : row.team,
      }))
    );
  } else {
    const sort = sortBy === 'name' ? { firstName: dir, lastName: dir } : { [sortBy]: dir };
    usersPromise = User.find(query).sort(sort).skip(skip).limit(limit).populate('team', 'name');
  }

  const [users, total] = await Promise.all([usersPromise, User.countDocuments(query)]);

  return {
    people: users.map((user) => serializePerson(user, actor)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getPerson({ userId, actor }) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  const person = await User.findOne({ _id: userId, organization: actor.organization }).populate('team', 'name');
  if (!person) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  if (!canViewPerson(actor, person)) {
    throw new AppError('You do not have access to this user', 403, 'FORBIDDEN');
  }
  return { person: serializePerson(person, actor) };
}

async function updatePerson({ userId, actor, updates, req }) {
  const person = await findManageableTarget({ userId, actor });
  const isSelf = person._id.toString() === actor._id.toString();

  if (updates.orgBlocked !== undefined && isSelf) {
    throw new AppError('You cannot block or unblock your own account', 400, 'CANNOT_BLOCK_SELF');
  }
  if (updates.role !== undefined) {
    if (!ROLE_ADMIN_ROLES.includes(actor.role)) {
      throw new AppError('Only an org admin or admin can change roles', 403, 'FORBIDDEN');
    }
    if (isSelf) {
      throw new AppError('You cannot change your own role', 400, 'CANNOT_CHANGE_OWN_ROLE');
    }
  }

  const changedFields = [];
  let roleChange = null;
  let orgBlockedChange = null;

  if (updates.skills !== undefined) {
    person.skills = updates.skills;
    changedFields.push('skills');
  }
  if (updates.role !== undefined && updates.role !== person.role) {
    roleChange = { from: person.role, to: updates.role };
    person.role = updates.role;
  }
  if (updates.orgBlocked !== undefined && updates.orgBlocked !== person.orgBlocked) {
    orgBlockedChange = updates.orgBlocked;
    person.orgBlocked = updates.orgBlocked;
    person.orgBlockedAt = updates.orgBlocked ? new Date() : null;
  }

  if (updates.teamId !== undefined) {
    if (updates.teamId === null) {
      await teamService.removeUserFromAllTeams({ user: person, actor, req });
    } else {
      await teamService.moveUserToTeam({ user: person, teamId: updates.teamId, actor, req });
    }
    changedFields.push('team');
  }

  await person.save();

  if (changedFields.length > 0) {
    await logAudit({
      action: AUDIT_EVENTS.PERSON_UPDATED,
      entityType: 'person',
      entityId: userId,
      metadata: {
        fields: changedFields,
        skills: person.skills,
        team: idOf(person.team),
      },
      organizationId: actor.organization,
      userId: idOf(actor._id),
      req,
    });
  }

  if (roleChange) {
    await logAudit({
      action: AUDIT_EVENTS.ROLE_CHANGED,
      entityType: 'person',
      entityId: userId,
      metadata: roleChange,
      organizationId: actor.organization,
      userId: idOf(actor._id),
      req,
    });

    await notificationEvents.personRoleChanged({ person, actor, role: roleChange.to });
  }

  if (orgBlockedChange !== null) {
    await logAudit({
      action: orgBlockedChange ? AUDIT_EVENTS.PERSON_BLOCKED : AUDIT_EVENTS.PERSON_UNBLOCKED,
      entityType: 'person',
      entityId: userId,
      metadata: {},
      organizationId: actor.organization,
      userId: idOf(actor._id),
      req,
    });

    if (orgBlockedChange) {
      // A blocked person can't use the app: drop their live streams everywhere
      // and tell them by email only (organization name, nothing else).
      await notificationHub.closeUser(person._id, 'blocked');
      await notificationEvents.personAccessBlocked({ person, organizationId: actor.organization });
    } else {
      await notificationEvents.personAccessRestored({ person, actor });
    }
  }

  await person.populate('team', 'name');
  return { person: serializePerson(person, actor) };
}

async function removeFromOrganization({ userId, actor, req }) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  const person = await User.findById(userId);
  if (!person || idOf(person.organization) !== idOf(actor.organization)) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  if (!ROLE_ADMIN_ROLES.includes(actor.role)) {
    throw new AppError('Only an org admin or admin can remove a user from the organization', 403, 'FORBIDDEN');
  }
  if (person._id.toString() === actor._id.toString()) {
    throw new AppError('You cannot remove yourself from the organization', 400, 'CANNOT_REMOVE_SELF');
  }

  await teamService.removeUserFromAllTeams({ user: person, actor, req, silent: true });

  person.organization = null;
  person.team = null;
  person.orgBlocked = false;
  person.orgBlockedAt = null;
  person.tokenVersion += 1;
  await person.save();
  await revokeAllSessionsForUser(person._id, 'removed_from_org');

  await logAudit({
    action: AUDIT_EVENTS.PERSON_REMOVED,
    entityType: 'person',
    entityId: userId,
    metadata: { email: person.email },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  await notificationHub.closeUser(person._id, 'removed');
  await notificationEvents.personRemovedFromOrganization({ person, organizationId: actor.organization });

  return { removed: true };
}

async function forcePasswordReset({ userId, actor, req }) {
  const person = await findManageableTarget({ userId, actor });
  if (person._id.toString() === actor._id.toString()) {
    throw new AppError('Use the account settings to reset your own password', 400, 'CANNOT_RESET_OWN_PASSWORD');
  }

  person.tokenVersion += 1;
  await person.save();
  await revokeAllSessionsForUser(person._id, 'admin_forced_reset');

  const resetToken = await createPasswordResetToken(person.email);
  const resetUrl = `${env.CLIENT_URL}/reset-password?email=${encodeURIComponent(person.email)}&token=${encodeURIComponent(resetToken)}`;
  await sendPasswordResetEmail({ firstName: person.firstName, resetUrl, to: person.email });

  await logAudit({
    action: AUDIT_EVENTS.PERSON_SESSIONS_REVOKED,
    entityType: 'person',
    entityId: userId,
    metadata: { passwordResetSent: true },
    organizationId: actor.organization,
    userId: idOf(actor._id),
    req,
  });

  // The reset email above is the out-of-band notice; this in-app record is
  // what they see after signing back in. No second email.
  await notificationHub.closeUser(person._id, 'sessions_revoked');
  await notificationEvents.personPasswordResetForced({ person, actor });

  return { message: 'Sessions revoked and password reset email sent' };
}

module.exports = {
  forcePasswordReset,
  getPerson,
  listPeople,
  removeFromOrganization,
  updatePerson,
};
