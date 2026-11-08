const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { SHARE_PERMISSIONS } = require('../constants/document.constants');
const Document = require('../models/Document');
const User = require('../models/User');
const { ROLES } = require('../constants/roles');
const { isSameId } = require('../utils/documentAccess');
const { assertCanManage, assertObjectId, getAccessibleDocument } = require('./documentAccess.service');
const { logAudit } = require('./audit.service');
const notificationEvents = require('./notificationEvents');

function serializePerson(user) {
  return {
    id: user._id.toString(),
    fullName: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    role: user.role,
  };
}

/** Who can see this document right now: owner, audience rule, explicit shares. */
async function listShares({ actor, id }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanManage(access);

  await document.populate([
    { path: 'owner', select: 'firstName lastName email role' },
    { path: 'team', select: 'name' },
    { path: 'project', select: 'name' },
    { path: 'sharedWith.user', select: 'firstName lastName email role isActive orgBlocked organization' },
    { path: 'sharedWith.sharedBy', select: 'firstName lastName' },
  ]);

  const shares = document.sharedWith
    .filter((share) => share.user)
    .map((share) => ({
      user: serializePerson(share.user),
      permission: share.permission,
      sharedAt: share.sharedAt,
      sharedBy: share.sharedBy
        ? { id: share.sharedBy._id.toString(), fullName: `${share.sharedBy.firstName} ${share.sharedBy.lastName}`.trim() }
        : null,
      // A blocked / removed person keeps their row (so it can be cleaned up)
      // but can no longer reach the file.
      active:
        share.user.isActive !== false &&
        !share.user.orgBlocked &&
        isSameId(share.user.organization, document.organization),
    }));

  return {
    owner: serializePerson(document.owner),
    visibility: document.visibility,
    team: document.team ? { id: document.team._id.toString(), name: document.team.name } : null,
    project: document.project ? { id: document.project._id.toString(), name: document.project.name } : null,
    shares,
  };
}

async function addShare({ actor, id, userId, permission, req }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanManage(access);

  assertObjectId(userId, 'User');
  const target = await User.findOne({ _id: userId, organization: actor.organization });
  // Cross-org or unknown ids look identical to the caller.
  if (!target) {
    throw new AppError('User not found in your organization', 404, 'NOT_FOUND');
  }
  if (!target.isActive || target.orgBlocked) {
    throw new AppError('This user cannot be given access', 400, 'USER_INACTIVE');
  }
  if (isSameId(target._id, document.owner)) {
    throw new AppError('The owner already has full access', 400, 'ALREADY_OWNER');
  }
  // Guests are read-only by policy, so an editor grant would be meaningless.
  if (target.role === ROLES.GUEST && permission !== SHARE_PERMISSIONS.VIEWER) {
    throw new AppError('Guests can only be given view access', 400, 'GUEST_VIEWER_ONLY');
  }

  const existing = document.sharedWith.find((share) => isSameId(share.user, target._id));
  const previous = existing ? existing.permission : null;
  if (existing) {
    existing.permission = permission;
    existing.sharedBy = actor._id;
    existing.sharedAt = new Date();
  } else {
    document.sharedWith.push({ user: target._id, permission, sharedBy: actor._id });
  }
  await document.save();
  const sharedAt = document.sharedWith.find((share) => isSameId(share.user, target._id))?.sharedAt;

  await logAudit({
    action: AUDIT_EVENTS.DOCUMENT_SHARED,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name, sharedWith: target._id.toString(), permission, previousPermission: previous },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.documentShared({ document, actor, userId: target._id, permission, sharedAt });

  return { success: true, share: { user: serializePerson(target), permission } };
}

async function revokeShare({ actor, id, userId, req }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanManage(access);

  assertObjectId(userId, 'User');
  const before = document.sharedWith.length;
  const updated = await Document.findOneAndUpdate(
    { _id: document._id, organization: actor.organization },
    { $pull: { sharedWith: { user: userId } } },
    { new: true },
  );
  if (!updated || updated.sharedWith.length === before) {
    throw new AppError('This document is not shared with that user', 404, 'NOT_FOUND');
  }

  await logAudit({
    action: AUDIT_EVENTS.DOCUMENT_SHARE_REVOKED,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name, revokedFrom: userId },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.documentAccessRevoked({ document: updated, actor, userId });

  return { success: true };
}

module.exports = { addShare, listShares, revokeShare };
