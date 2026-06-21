const asyncHandler = require('../utils/async-handler');
const {
  getOrganization,
  listOrganizations,
  reactivateOrganization,
  suspendOrganization,
  updateFeatureFlags,
  updateOrganizationPlan,
} = require('../services/platform.service');

const list = asyncHandler(async (req, res) => {
  const result = await listOrganizations(req.query);
  return res.status(200).json({ success: true, ...result });
});

const getOne = asyncHandler(async (req, res) => {
  const organization = await getOrganization(req.params.id);
  return res.status(200).json({ success: true, organization });
});

const updatePlan = asyncHandler(async (req, res) => {
  const organization = await updateOrganizationPlan({
    organizationId: req.params.id,
    plan: req.body.plan,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, organization });
});

const suspend = asyncHandler(async (req, res) => {
  const organization = await suspendOrganization({
    organizationId: req.params.id,
    reason: req.body.reason,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, organization });
});

const reactivate = asyncHandler(async (req, res) => {
  const organization = await reactivateOrganization({
    organizationId: req.params.id,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, organization });
});

const updateFlags = asyncHandler(async (req, res) => {
  const organization = await updateFeatureFlags({
    organizationId: req.params.id,
    featureFlags: req.body.featureFlags,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, organization });
});

module.exports = {
  getOne,
  list,
  reactivate,
  suspend,
  updateFlags,
  updatePlan,
};
