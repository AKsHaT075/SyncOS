const asyncHandler = require('../utils/async-handler');
const { getUsage } = require('../services/planLimits.service');
const { createOrganization, getOrganizationsForUser, updateOrganization } = require('../services/organization.service');

const create = asyncHandler(async (req, res) => {
  const { organization } = await createOrganization({ ...req.body, owner: req.user, req });
  return res.status(201).json({ success: true, organization: organization.toSafeObject() });
});

const listMine = asyncHandler(async (req, res) => {
  const organizations = await getOrganizationsForUser(req.user);
  return res.status(200).json({ success: true, organizations: organizations.map((org) => org.toSafeObject()) });
});

const update = asyncHandler(async (req, res) => {
  const { organization } = await updateOrganization({ actor: req.user, changes: req.body, req });
  return res.status(200).json({ success: true, organization: organization.toSafeObject() });
});

const usage = asyncHandler(async (req, res) => {
  return res.status(200).json({ success: true, usage: await getUsage(req.user.organization) });
});

module.exports = {
  update,
  usage,
  create,
  listMine,
};
