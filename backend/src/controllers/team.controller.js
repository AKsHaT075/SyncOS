const asyncHandler = require('../utils/async-handler');
const teamService = require('../services/team.service');

const create = asyncHandler(async (req, res) => {
  const team = await teamService.createTeam({ ...req.body, actor: req.user, req });
  return res.status(201).json({ success: true, team });
});

const list = asyncHandler(async (req, res) => {
  const result = await teamService.listTeams({ ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const my = asyncHandler(async (req, res) => {
  const result = await teamService.getMyTeam({ actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const getById = asyncHandler(async (req, res) => {
  const team = await teamService.getTeam({ teamId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, team });
});

const update = asyncHandler(async (req, res) => {
  const team = await teamService.updateTeam({ teamId: req.params.id, actor: req.user, updates: req.body, req });
  return res.status(200).json({ success: true, team });
});

const remove = asyncHandler(async (req, res) => {
  const result = await teamService.deleteTeam({ teamId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, ...result });
});

const addMember = asyncHandler(async (req, res) => {
  const team = await teamService.addMember({
    teamId: req.params.id,
    actor: req.user,
    userId: req.body.userId,
    req,
  });
  return res.status(200).json({ success: true, team });
});

const removeMember = asyncHandler(async (req, res) => {
  const team = await teamService.removeMember({
    teamId: req.params.id,
    actor: req.user,
    userId: req.params.memberId,
    req,
  });
  return res.status(200).json({ success: true, team });
});

const setManager = asyncHandler(async (req, res) => {
  const team = await teamService.setManager({
    teamId: req.params.id,
    actor: req.user,
    userId: req.body.userId,
    req,
  });
  return res.status(200).json({ success: true, team });
});

const memberCandidates = asyncHandler(async (req, res) => {
  const result = await teamService.listMemberCandidates({
    teamId: req.params.id,
    actor: req.user,
    search: req.query.search,
    role: req.query.role,
  });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  addMember,
  create,
  getById,
  list,
  memberCandidates,
  my,
  remove,
  removeMember,
  setManager,
  update,
};
