const asyncHandler = require('../utils/async-handler');
const { createOrganization, getOrganizationsForUser } = require('../services/organization.service');

const create = asyncHandler(async (req, res) => {
  const { organization } = await createOrganization({ ...req.body, owner: req.user, req });
  return res.status(201).json({ success: true, organization: organization.toSafeObject() });
});

const listMine = asyncHandler(async (req, res) => {
  const organizations = await getOrganizationsForUser(req.user);
  return res.status(200).json({ success: true, organizations: organizations.map((org) => org.toSafeObject()) });
});

module.exports = {
  create,
  listMine,
};
