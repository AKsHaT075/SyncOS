const asyncHandler = require('../utils/async-handler');
const {
  deleteResource,
  getResourceForDownload,
  listResources,
  uploadResource,
} = require('../services/projectResource.service');

const list = asyncHandler(async (req, res) => {
  const result = await listResources({ projectId: req.params.id, actor: req.user });
  return res.status(200).json({ success: true, ...result });
});

const upload = asyncHandler(async (req, res) => {
  const result = await uploadResource({ projectId: req.params.id, actor: req.user, file: req.file, req });
  return res.status(201).json({ success: true, ...result });
});

const download = asyncHandler(async (req, res) => {
  const { resource, absolutePath } = await getResourceForDownload({
    projectId: req.params.id,
    resourceId: req.params.resourceId,
    actor: req.user,
  });
  return res.download(absolutePath, resource.originalName);
});

const remove = asyncHandler(async (req, res) => {
  const result = await deleteResource({
    projectId: req.params.id,
    resourceId: req.params.resourceId,
    actor: req.user,
    req,
  });
  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  download,
  list,
  remove,
  upload,
};
