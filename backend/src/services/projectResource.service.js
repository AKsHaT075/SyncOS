const fs = require('fs/promises');
const path = require('path');
const { assertStorageAvailable } = require('./planLimits.service');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { canManageProject, canViewProject } = require('../utils/projectAccess');
const { findActiveProject } = require('./project.service');
const { UPLOAD_ROOT } = require('../middlewares/upload');
const ProjectResource = require('../models/ProjectResource');
const { logAudit } = require('./audit.service');

function assertCanView(actor, project) {
  if (!canViewProject(actor, project)) {
    throw new AppError('You do not have access to this project', 403, 'FORBIDDEN');
  }
}

// Uploading/removing resources is a project-management action, not a
// coarse org permission — the same gate used for update/archive/members, so
// a project Owner/Manager can share files with their team regardless of
// whether their org role happens to carry a global "upload document" grant.
function assertCanManage(actor, project) {
  if (!canManageProject(actor, project)) {
    throw new AppError('You do not have permission to manage this project', 403, 'FORBIDDEN');
  }
}

async function listResources({ projectId, actor }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);

  const resources = await ProjectResource.find({ project: project._id })
    .sort({ createdAt: -1 })
    .populate('uploadedBy', 'firstName lastName email');

  return { resources: resources.map((resource) => resource.toSafeObject()) };
}

async function uploadResource({ projectId, actor, file, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  if (!file) {
    throw new AppError('A file is required', 400, 'FILE_REQUIRED');
  }

  await assertStorageAvailable(actor.organization, file.size);
  const resource = await ProjectResource.create({
    organization: actor.organization,
    project: project._id,
    fileName: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: actor._id,
  });

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_RESOURCE_UPLOADED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { resourceId: resource._id.toString(), name: resource.originalName },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await resource.populate('uploadedBy', 'firstName lastName email');
  return { resource: resource.toSafeObject() };
}

async function findResourceOrThrow(projectId, resourceId, organization) {
  const resource = await ProjectResource.findOne({ _id: resourceId, project: projectId, organization });
  if (!resource) {
    throw new AppError('Resource not found', 404, 'NOT_FOUND');
  }
  return resource;
}

async function getResourceForDownload({ projectId, resourceId, actor }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanView(actor, project);

  const resource = await findResourceOrThrow(project._id, resourceId, actor.organization);
  return { resource, absolutePath: path.join(UPLOAD_ROOT, resource.fileName) };
}

async function deleteResource({ projectId, resourceId, actor, req }) {
  const project = await findActiveProject(projectId, actor.organization);
  assertCanManage(actor, project);

  const resource = await findResourceOrThrow(project._id, resourceId, actor.organization);
  const absolutePath = path.join(UPLOAD_ROOT, resource.fileName);

  await resource.deleteOne();
  await fs.unlink(absolutePath).catch(() => {});

  await logAudit({
    action: AUDIT_EVENTS.PROJECT_RESOURCE_DELETED,
    entityId: project._id.toString(),
    entityType: 'project',
    metadata: { resourceId: resource._id.toString(), name: resource.originalName },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true };
}

module.exports = {
  deleteResource,
  getResourceForDownload,
  listResources,
  uploadResource,
};
