const asyncHandler = require('../utils/async-handler');
const {
  addMember,
  archiveProject,
  createProject,
  favoriteProject,
  getProject,
  listMemberCandidates,
  listProjectActivity,
  listProjects,
  removeMember,
  restoreProject,
  softDeleteProject,
  transferOwnership,
  unfavoriteProject,
  updateMemberRole,
  updateProject,
} = require('../services/project.service');

const create = asyncHandler(async (req, res) => {
  const project = await createProject({ ...req.body, creator: req.user, req });
  return res.status(201).json({ success: true, project });
});

const list = asyncHandler(async (req, res) => {
  const result = await listProjects({ ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const getById = asyncHandler(async (req, res) => {
  const project = await getProject({ projectId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, project });
});

const update = asyncHandler(async (req, res) => {
  const project = await updateProject({ projectId: req.params.id, actor: req.user, updates: req.body, req });
  return res.status(200).json({ success: true, project });
});

const archive = asyncHandler(async (req, res) => {
  const project = await archiveProject({ projectId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, project });
});

const restore = asyncHandler(async (req, res) => {
  const project = await restoreProject({ projectId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, project });
});

const remove = asyncHandler(async (req, res) => {
  const result = await softDeleteProject({ projectId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, ...result });
});

const favorite = asyncHandler(async (req, res) => {
  const project = await favoriteProject({ projectId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, project });
});

const unfavorite = asyncHandler(async (req, res) => {
  const project = await unfavoriteProject({ projectId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, project });
});

const addProjectMember = asyncHandler(async (req, res) => {
  const project = await addMember({ projectId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(201).json({ success: true, project });
});

const updateProjectMemberRole = asyncHandler(async (req, res) => {
  const project = await updateMemberRole({
    projectId: req.params.id,
    actor: req.user,
    userId: req.params.userId,
    role: req.body.role,
    req,
  });
  return res.status(200).json({ success: true, project });
});

const removeProjectMember = asyncHandler(async (req, res) => {
  const project = await removeMember({
    projectId: req.params.id,
    actor: req.user,
    userId: req.params.userId,
    req,
  });
  return res.status(200).json({ success: true, project });
});

const activity = asyncHandler(async (req, res) => {
  const result = await listProjectActivity({ projectId: req.params.id, actor: req.user, ...req.query });
  return res.status(200).json({ success: true, ...result });
});

const memberCandidates = asyncHandler(async (req, res) => {
  const result = await listMemberCandidates({ projectId: req.params.id, actor: req.user, ...req.query });
  return res.status(200).json({ success: true, ...result });
});

const transfer = asyncHandler(async (req, res) => {
  const project = await transferOwnership({ projectId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, project });
});

module.exports = {
  activity,
  addProjectMember,
  archive,
  create,
  favorite,
  getById,
  list,
  memberCandidates,
  remove,
  removeProjectMember,
  restore,
  transfer,
  unfavorite,
  update,
  updateProjectMemberRole,
};
