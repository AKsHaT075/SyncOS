const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const Organization = require('../models/Organization');
const { logAudit } = require('./audit.service');

/**
 * Platform-administration surface for SUPER_ADMIN. Every function here
 * touches Organization metadata only (plan, limits, isActive) — never
 * Users/Teams/Projects/etc. inside a tenant. That boundary is what keeps
 * "super admins manage organizations, not company data" true in code, not
 * just in the docs.
 */

async function listOrganizations({ search, page = 1, limit = 20 }) {
  const query = {};
  if (search) {
    query.name = { $regex: search, $options: 'i' };
  }

  const skip = (page - 1) * limit;
  const [organizations, total] = await Promise.all([
    Organization.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Organization.countDocuments(query),
  ]);

  return {
    organizations: organizations.map((org) => org.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function getOrganization(organizationId) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }
  return organization.toSafeObject();
}

async function updateOrganizationPlan({ organizationId, plan, actor, req }) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  const previousPlan = organization.plan;
  organization.plan = plan;
  await organization.save();

  await logAudit({
    action: AUDIT_EVENTS.ORG_PLAN_CHANGED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    metadata: { previousPlan, plan },
    req,
    userId: actor._id,
  });

  return organization.toSafeObject();
}

async function suspendOrganization({ organizationId, reason, actor, req }) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  organization.isActive = false;
  organization.suspendedAt = new Date();
  organization.suspendedReason = reason || null;
  await organization.save();

  await logAudit({
    action: AUDIT_EVENTS.ORG_SUSPENDED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    metadata: { reason },
    req,
    userId: actor._id,
  });

  return organization.toSafeObject();
}

async function reactivateOrganization({ organizationId, actor, req }) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  organization.isActive = true;
  organization.suspendedAt = null;
  organization.suspendedReason = null;
  await organization.save();

  await logAudit({
    action: AUDIT_EVENTS.ORG_REACTIVATED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    req,
    userId: actor._id,
  });

  return organization.toSafeObject();
}

async function updateFeatureFlags({ organizationId, featureFlags, actor, req }) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found', 404, 'NOT_FOUND');
  }

  organization.featureFlags = { ...organization.featureFlags, ...featureFlags };
  await organization.save();

  await logAudit({
    action: AUDIT_EVENTS.ORG_PLAN_CHANGED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    metadata: { featureFlags: organization.featureFlags },
    req,
    userId: actor._id,
  });

  return organization.toSafeObject();
}

module.exports = {
  getOrganization,
  listOrganizations,
  reactivateOrganization,
  suspendOrganization,
  updateFeatureFlags,
  updateOrganizationPlan,
};
