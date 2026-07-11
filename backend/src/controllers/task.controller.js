const asyncHandler = require('../utils/async-handler');
const {
  addAttachment,
  archiveTask,
  createTask,
  getAttachmentForDownload,
  getTask,
  listMyTasks,
  listTaskActivity,
  listTasks,
  removeAttachment,
  reviewTask,
  softDeleteTask,
  submitForReview,
  unarchiveTask,
  updateTask,
} = require('../services/task.service');

const create = asyncHandler(async (req, res) => {
  const task = await createTask({ projectId: req.params.projectId, ...req.body, creator: req.user, req });
  return res.status(201).json({ success: true, task });
});

const list = asyncHandler(async (req, res) => {
  const result = await listTasks({ projectId: req.params.projectId, ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const listMy = asyncHandler(async (req, res) => {
  const result = await listMyTasks({ ...req.query, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const getById = asyncHandler(async (req, res) => {
  const task = await getTask({ taskId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, task });
});

const update = asyncHandler(async (req, res) => {
  const task = await updateTask({ taskId: req.params.id, actor: req.user, updates: req.body, req });
  return res.status(200).json({ success: true, task });
});

const remove = asyncHandler(async (req, res) => {
  const result = await softDeleteTask({ taskId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, ...result });
});

const archive = asyncHandler(async (req, res) => {
  const task = await archiveTask({ taskId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, task });
});

const unarchive = asyncHandler(async (req, res) => {
  const task = await unarchiveTask({ taskId: req.params.id, actor: req.user, req });
  return res.status(200).json({ success: true, task });
});

const submit = asyncHandler(async (req, res) => {
  const task = await submitForReview({ taskId: req.params.id, actor: req.user, ...req.body, files: req.files, req });
  return res.status(200).json({ success: true, task });
});

const uploadAttachment = asyncHandler(async (req, res) => {
  const task = await addAttachment({ taskId: req.params.id, actor: req.user, file: req.file, req });
  return res.status(201).json({ success: true, task });
});

const downloadAttachment = asyncHandler(async (req, res) => {
  const { attachment, absolutePath } = await getAttachmentForDownload({
    taskId: req.params.id,
    attachmentId: req.params.attachmentId,
    actor: req.user,
  });
  return res.download(absolutePath, attachment.originalName);
});

const removeAttachmentHandler = asyncHandler(async (req, res) => {
  const task = await removeAttachment({
    taskId: req.params.id,
    attachmentId: req.params.attachmentId,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, task });
});

const review = asyncHandler(async (req, res) => {
  const task = await reviewTask({ taskId: req.params.id, actor: req.user, ...req.body, req });
  return res.status(200).json({ success: true, task });
});

const activity = asyncHandler(async (req, res) => {
  const result = await listTaskActivity({ taskId: req.params.id, actor: req.user, ...req.query });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  activity,
  archive,
  create,
  downloadAttachment,
  getById,
  list,
  listMy,
  remove,
  removeAttachmentHandler,
  review,
  submit,
  unarchive,
  update,
  uploadAttachment,
};
