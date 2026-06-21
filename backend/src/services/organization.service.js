const AppError = require('../utils/app-error');
const slugify = require('../utils/slugify');
const { generateRandomToken } = require('../utils/crypto');
const { ROLES } = require('../constants/roles');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const Organization = require('../models/Organization');
const User = require('../models/User');
const { logAudit } = require('./audit.service');

/**
 * Single seam for "which organizations does this user belong to". Today a
 * user has exactly one `organization`, so this just wraps that field in an
 * array. When a Membership model lands (a user in many orgs, with a role
 * per org), only this function's body needs to change — every caller
 * already treats org membership as a list.
 */
async function getOrganizationsForUser(user) {
  if (!user.organization) {
    return [];
  }

  const organization = await Organization.findById(user.organization);
  return organization ? [organization] : [];
}

async function generateUniqueSlug(name) {
  const base = slugify(name) || 'organization';
  let slug = base;
  let attempt = 0;

  while (await Organization.exists({ slug })) {
    attempt += 1;
    slug = `${base}-${attempt === 1 ? generateRandomToken(3) : attempt}`;
  }

  return slug;
}

async function createOrganization({ name, owner, req }) {
  if (owner.hasCreatedOrganization) {
    throw new AppError('You have already created an organization', 409, 'ORGANIZATION_ALREADY_CREATED');
  }

  const slug = await generateUniqueSlug(name);

  const organization = await Organization.create({
    name: name.trim(),
    slug,
    createdBy: owner._id,
  });

  await User.findByIdAndUpdate(owner._id, {
    organization: organization._id,
    role: ROLES.ORG_ADMIN,
    hasCreatedOrganization: true,
  });

  await logAudit({
    action: AUDIT_EVENTS.ORG_CREATED,
    entityId: organization._id.toString(),
    entityType: 'organization',
    metadata: { name: organization.name, slug: organization.slug },
    organizationId: organization._id,
    req,
    userId: owner._id,
  });

  return { organization };
}

module.exports = {
  createOrganization,
  getOrganizationsForUser,
};
