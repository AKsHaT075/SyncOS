const mongoose = require('mongoose');
const env = require('../config/env');
const AppError = require('../utils/app-error');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const DocumentVersion = require('../models/DocumentVersion');
const ProjectResource = require('../models/ProjectResource');

/**
 * The ONE place plan limits are read and enforced.
 *
 * Where the numbers come from: `Organization.limits` ({ seats, aiCredits, storageGB }) is the only plan configuration that exists. There is
 * no plan -> limits table in the code and none is invented here: a limit is whatever is stored on the organization (defaults live in the
 * schema; a super-admin can change them through PATCH /platform/organizations/:id/limits).
 *
 * Rules (also in docs/modules.md):
 *  - seats / storageGB: a positive number is enforced; a missing, zero or non-numeric value means "no limit".
 *  - A limit stops NEW consumption only (new invitation/acceptance, new upload). Nothing existing is removed, blocked or deleted, so an
 *    organization already over a limit keeps working and simply cannot grow until it is under again.
 *  - aiCredits: no "credit" unit exists in the product (AI is metered in tokens). The conversion is explicit configuration,
 *    AI_TOKENS_PER_CREDIT. While it is unset nothing is enforced. When set, a positive aiCredits caps the organization's monthly AI tokens at
 *    aiCredits * AI_TOKENS_PER_CREDIT (never above the organization's own quota); aiCredits 0 means "not capped by plan".
 */

const BYTES_PER_GB = 1024 ** 3;
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);
const objectId = (value) => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value)));

async function getLimits(organizationId) {
  const organization = await Organization.findById(organizationId).select('plan limits').lean();
  if (!organization) throw new AppError('Organization not found', 404, 'NOT_FOUND');
  const limits = organization.limits || {};
  return { plan: organization.plan, seats: positive(limits.seats), storageGB: positive(limits.storageGB), aiCredits: Number.isFinite(limits.aiCredits) ? limits.aiCredits : 0 };
}

/** People who hold a seat: active accounts in the organization that are not blocked. */
async function countMembers(organizationId) {
  return User.countDocuments({ organization: organizationId, isActive: true, orgBlocked: { $ne: true } });
}

async function countPendingInvitations(organizationId) {
  return Invitation.countDocuments({ organization: organizationId, status: 'pending', expiresAt: { $gt: new Date() } });
}

async function storageUsedBytes(organizationId) {
  const org = objectId(organizationId);
  const sum = async (Model) => {
    const [row] = await Model.aggregate([{ $match: { organization: org } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]);
    return row ? row.bytes : 0;
  };
  const [versions, resources] = await Promise.all([sum(DocumentVersion), sum(ProjectResource)]);
  return versions + resources;
}

async function getUsage(organizationId) {
  const [limits, members, pendingInvitations, usedBytes] = await Promise.all([getLimits(organizationId), countMembers(organizationId), countPendingInvitations(organizationId), storageUsedBytes(organizationId)]);
  return {
    plan: limits.plan,
    seats: { used: members, pendingInvitations, limit: limits.seats },
    storage: { usedBytes, limitBytes: limits.storageGB ? Math.round(limits.storageGB * BYTES_PER_GB) : null, limitGB: limits.storageGB },
    aiCredits: { limit: limits.aiCredits, enforced: Boolean(env.AI_TOKENS_PER_CREDIT && limits.aiCredits > 0) },
  };
}

/** Inviting reserves a seat: members + pending invitations (including the new one) must fit. */
async function assertSeatForInvitation(organizationId) {
  const { seats } = await getLimits(organizationId);
  if (!seats) return;
  const [members, pending] = await Promise.all([countMembers(organizationId), countPendingInvitations(organizationId)]);
  if (members + pending + 1 > seats) {
    throw new AppError(`Your plan allows ${seats} seats and they are all in use or reserved by pending invitations`, 403, 'SEAT_LIMIT_REACHED', { seats });
  }
}

/** Accepting turns a reserved seat into a member; only real members are counted (other pending invitations do not block it). */
async function assertSeatForMember(organizationId) {
  const { seats } = await getLimits(organizationId);
  if (!seats) return;
  if ((await countMembers(organizationId)) + 1 > seats) {
    throw new AppError(`This organization has reached its ${seats} seat limit`, 403, 'SEAT_LIMIT_REACHED', { seats });
  }
}

async function assertStorageAvailable(organizationId, incomingBytes) {
  const { storageGB } = await getLimits(organizationId);
  if (!storageGB) return;
  const limitBytes = Math.round(storageGB * BYTES_PER_GB);
  const used = await storageUsedBytes(organizationId);
  if (used + Math.max(0, Number(incomingBytes) || 0) > limitBytes) {
    throw new AppError(`This upload would exceed the ${storageGB} GB storage limit of your plan`, 413, 'STORAGE_LIMIT_REACHED', { limitBytes, usedBytes: used });
  }
}

/** Applies the plan's AI credit cap to already-resolved quotas. A pure no-op unless AI_TOKENS_PER_CREDIT is configured. */
async function capAiQuotas(organizationId, quotas) {
  const perCredit = env.AI_TOKENS_PER_CREDIT;
  if (!perCredit) return quotas;
  const { aiCredits } = await getLimits(organizationId);
  if (!(aiCredits > 0)) return quotas;
  return { ...quotas, orgMonthlyTokens: Math.min(quotas.orgMonthlyTokens, Math.floor(aiCredits * perCredit)) };
}

module.exports = { assertSeatForInvitation, assertSeatForMember, assertStorageAvailable, capAiQuotas, getLimits, getUsage };
