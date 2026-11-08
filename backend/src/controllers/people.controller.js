const asyncHandler = require('../utils/async-handler');
const peopleService = require('../services/people.service');

const list = asyncHandler(async (req, res) => {
  const result = await peopleService.listPeople({ ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const getById = asyncHandler(async (req, res) => {
  const result = await peopleService.getPerson({ userId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const update = asyncHandler(async (req, res) => {
  const result = await peopleService.updatePerson({
    userId: req.params.id,
    actor: req.user,
    updates: req.body,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

const remove = asyncHandler(async (req, res) => {
  const result = await peopleService.removeFromOrganization({
    userId: req.params.id,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

const forcePasswordReset = asyncHandler(async (req, res) => {
  const result = await peopleService.forcePasswordReset({
    userId: req.params.id,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

module.exports = { forcePasswordReset, getById, list, remove, update };
