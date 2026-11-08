const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { ALLOWED_FILE_TYPES, DOCUMENT_VISIBILITY } = require('../constants/document.constants');
const { PERMISSIONS } = require('../constants/permissions');
const AuditLog = require('../models/AuditLog');
const Document = require('../models/Document');
const DocumentFolder = require('../models/DocumentFolder');
const DocumentVersion = require('../models/DocumentVersion');
const Project = require('../models/Project');
const Team = require('../models/Team');
const { getStorage, generateStorageKey } = require('../storage');
const {
  buildDocumentVisibilityFilter,
  canPublishOrgWide,
  hasPermission,
  idOf,
  isDocumentAdmin,
  isGuest,
  resolveDocumentAccess,
} = require('../utils/documentAccess');
const { decodeOriginalName, inspectUpload, withExtension } = require('../utils/fileValidation');
const { TEAM_ADMIN_ROLES } = require('../utils/teamAccess');
const {
  assertCanEdit,
  assertCanManage,
  assertObjectId,
  getAccessibleDocument,
  loadAccessContext,
  publicAccess,
} = require('./documentAccess.service');
const { findFolder } = require('./documentFolder.service');
const { logAudit } = require('./audit.service');

const NAME_COLLATION = { locale: 'en', strength: 2 };

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withRelations(query) {
  return query
    .populate('owner', 'firstName lastName email')
    .populate('team', 'name')
    .populate('project', 'name');
}

function audit(actor, req, action, document, metadata = {}) {
  return logAudit({
    action,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name, ...metadata },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });
}

/**
 * Validates a (visibility, team, project) request against what the actor is
 * allowed to publish to. Prevents e.g. an employee exposing a file to a team
 * or project they don't belong to, or to the whole organization.
 */
async function resolveVisibilityTarget({ actor, ctx, visibility, teamId, projectId }) {
  switch (visibility) {
    case DOCUMENT_VISIBILITY.PRIVATE:
      return { visibility, team: null, project: null };

    case DOCUMENT_VISIBILITY.TEAM: {
      assertObjectId(teamId, 'Team');
      const team = await Team.findOne({ _id: teamId, organization: actor.organization }).select('_id').lean();
      if (!team) {
        throw new AppError('Team not found', 404, 'NOT_FOUND');
      }
      if (!TEAM_ADMIN_ROLES.includes(actor.role) && !ctx.teamIds.has(team._id.toString())) {
        throw new AppError('You can only share with teams you belong to', 403, 'FORBIDDEN');
      }
      return { visibility, team: team._id, project: null };
    }

    case DOCUMENT_VISIBILITY.PROJECT: {
      assertObjectId(projectId, 'Project');
      const project = await Project.findOne({ _id: projectId, organization: actor.organization, deletedAt: null })
        .select('_id')
        .lean();
      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }
      if (!isDocumentAdmin(actor) && !ctx.projectIds.has(project._id.toString())) {
        throw new AppError('You can only share with projects you are a member of', 403, 'FORBIDDEN');
      }
      return { visibility, team: null, project: project._id };
    }

    case DOCUMENT_VISIBILITY.ORGANIZATION:
      if (!canPublishOrgWide(actor)) {
        throw new AppError('Your role cannot publish documents to the whole organization', 403, 'ORG_PUBLISH_FORBIDDEN');
      }
      return { visibility, team: null, project: null };

    default:
      throw new AppError('Invalid visibility', 400, 'VALIDATION_ERROR');
  }
}

async function folderBreadcrumb(folderId, organization) {
  if (!folderId) return [];
  const folder = await DocumentFolder.findOne({ _id: folderId, organization }).select('name ancestors').lean();
  if (!folder) return [];
  const chain = await DocumentFolder.find({ _id: { $in: folder.ancestors }, organization }).select('name').lean();
  const names = new Map(chain.map((item) => [item._id.toString(), item.name]));
  return [
    ...folder.ancestors.map((id) => ({ id: id.toString(), name: names.get(id.toString()) || '…' })),
    { id: folder._id.toString(), name: folder.name },
  ];
}

async function listDocuments({ actor, query }) {
  const ctx = await loadAccessContext(actor);
  const filter = { organization: actor.organization, deletedAt: null };
  const and = [buildDocumentVisibilityFilter(ctx)];

  // Guests have no folder tree, so folder scoping is ignored for them.
  if (query.folderId && !isGuest(actor)) {
    filter.folder = query.folderId === 'root' ? null : query.folderId;
  }
  if (query.search) {
    filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
  }
  if (query.category) filter.category = query.category;
  if (query.visibility) filter.visibility = query.visibility;
  if (query.ownerId) filter.owner = query.ownerId;

  if (query.scope === 'mine') {
    and.push({ owner: actor._id });
  } else if (query.scope === 'shared') {
    and.push({ 'sharedWith.user': actor._id }, { owner: { $ne: actor._id } });
  }

  if (query.uploadedFrom || query.uploadedTo) {
    filter.createdAt = {};
    if (query.uploadedFrom) filter.createdAt.$gte = query.uploadedFrom;
    if (query.uploadedTo) filter.createdAt.$lte = query.uploadedTo;
  }
  filter.$and = and;

  const direction = query.sortOrder === 'asc' ? 1 : -1;
  const sort = { [query.sortBy]: direction, _id: direction };
  const skip = (query.page - 1) * query.limit;

  let find = Document.find(filter);
  if (query.sortBy === 'name') {
    find = find.collation(NAME_COLLATION);
  }

  const [documents, total] = await Promise.all([
    withRelations(find.sort(sort).skip(skip).limit(query.limit)),
    Document.countDocuments(filter),
  ]);

  return {
    documents: documents.map((document) => document.toSafeObject(publicAccess(resolveDocumentAccess(ctx, document)))),
    pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
  };
}

async function getDocument({ actor, id }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  await document.populate([
    { path: 'owner', select: 'firstName lastName email' },
    { path: 'team', select: 'name' },
    { path: 'project', select: 'name' },
  ]);
  const breadcrumb = isGuest(actor) ? [] : await folderBreadcrumb(document.folder, actor.organization);
  return { document: document.toSafeObject(publicAccess(access)), breadcrumb };
}

async function createDocument({ actor, file, body, req }) {
  if (!file) {
    throw new AppError('A file is required', 400, 'FILE_REQUIRED');
  }

  const originalName = decodeOriginalName(file.originalname);
  const meta = await inspectUpload({ filePath: file.path, originalName, clientMime: file.mimetype });

  const ctx = await loadAccessContext(actor);
  const folder = body.folderId ? await findFolder(body.folderId, actor.organization) : null;
  const target = await resolveVisibilityTarget({ actor, ctx, ...body });
  const name = withExtension(body.name || originalName, meta.extension);

  const storage = getStorage();
  const storageKey = generateStorageKey(actor.organization);
  await storage.put(storageKey, file.path);

  let document = null;
  try {
    document = await Document.create({
      organization: actor.organization,
      name,
      description: body.description || '',
      folder: folder?._id || null,
      owner: actor._id,
      visibility: target.visibility,
      team: target.team,
      project: target.project,
      extension: meta.extension,
      category: meta.category,
      mimeType: meta.mimeType,
      size: meta.size,
      checksum: meta.checksum,
      storageKey,
      currentVersion: 1,
      versionSeq: 1,
      updatedBy: actor._id,
    });
    await DocumentVersion.create({
      organization: actor.organization,
      document: document._id,
      version: 1,
      storageKey,
      fileName: name,
      mimeType: meta.mimeType,
      size: meta.size,
      checksum: meta.checksum,
      uploadedBy: actor._id,
      changeNote: 'Initial upload',
    });
  } catch (error) {
    // Don't leave an orphan blob or a half-created document behind.
    if (document) {
      await Document.deleteOne({ _id: document._id }).catch(() => {});
    }
    await storage.remove(storageKey).catch(() => {});
    throw error;
  }

  await audit(actor, req, AUDIT_EVENTS.DOCUMENT_UPLOADED, document, {
    size: meta.size,
    category: meta.category,
    visibility: document.visibility,
    folder: idOf(document.folder),
  });

  await document.populate([
    { path: 'owner', select: 'firstName lastName email' },
    { path: 'team', select: 'name' },
    { path: 'project', select: 'name' },
  ]);
  return { document: document.toSafeObject(publicAccess(resolveDocumentAccess(ctx, document))) };
}

async function updateDocument({ actor, id, updates, req }) {
  const { document, access, ctx } = await getAccessibleDocument(id, actor);

  const changesVisibility = updates.visibility !== undefined;
  const renames = updates.name !== undefined && withExtension(updates.name, document.extension) !== document.name;
  const editsDescription = updates.description !== undefined && updates.description !== document.description;

  if (renames || editsDescription) {
    assertCanEdit(access);
  }
  if (changesVisibility) {
    // Changing who can see a document is a sharing decision.
    assertCanManage(access);
    if (!hasPermission(actor, PERMISSIONS.SHARE_DOCUMENT)) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
  }

  const events = [];
  if (renames) {
    const from = document.name;
    document.name = withExtension(updates.name, document.extension);
    events.push([AUDIT_EVENTS.DOCUMENT_RENAMED, { from, to: document.name }]);
  }
  if (editsDescription) {
    document.description = updates.description;
    events.push([AUDIT_EVENTS.DOCUMENT_UPDATED, { field: 'description' }]);
  }
  if (changesVisibility) {
    const target = await resolveVisibilityTarget({ actor, ctx, ...updates });
    const from = document.visibility;
    document.visibility = target.visibility;
    document.team = target.team;
    document.project = target.project;
    if (from !== target.visibility || target.team || target.project) {
      events.push([AUDIT_EVENTS.DOCUMENT_VISIBILITY_CHANGED, { from, to: target.visibility }]);
    }
  }

  if (events.length) {
    document.updatedBy = actor._id;
    await document.save();
    for (const [action, metadata] of events) {
      // eslint-disable-next-line no-await-in-loop
      await audit(actor, req, action, document, metadata);
    }
  }

  await document.populate([
    { path: 'owner', select: 'firstName lastName email' },
    { path: 'team', select: 'name' },
    { path: 'project', select: 'name' },
  ]);
  return { document: document.toSafeObject(publicAccess(resolveDocumentAccess(ctx, document))) };
}

async function moveDocument({ actor, id, folderId, req }) {
  const { document, access, ctx } = await getAccessibleDocument(id, actor);
  assertCanManage(access);

  const folder = folderId ? await findFolder(folderId, actor.organization) : null;
  const from = idOf(document.folder);
  const to = folder ? folder._id.toString() : null;

  if (from !== to) {
    document.folder = folder?._id || null;
    document.updatedBy = actor._id;
    await document.save();
    await audit(actor, req, AUDIT_EVENTS.DOCUMENT_MOVED, document, { from, to });
  }

  await document.populate([
    { path: 'owner', select: 'firstName lastName email' },
    { path: 'team', select: 'name' },
    { path: 'project', select: 'name' },
  ]);
  return { document: document.toSafeObject(publicAccess(resolveDocumentAccess(ctx, document))) };
}

async function deleteDocument({ actor, id, req }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanManage(access);

  document.deletedAt = new Date();
  document.deletedBy = actor._id;
  document.trashedWithFolder = null;
  await document.save();

  await audit(actor, req, AUDIT_EVENTS.DOCUMENT_DELETED, document);
  return { success: true };
}

/**
 * Resolves the file to stream. Only the current version is available to
 * viewers; older versions require edit rights, so history never leaks to
 * someone who can merely read the latest file.
 */
async function getDownload({ actor, id, version, disposition, req }) {
  const { document, access } = await getAccessibleDocument(id, actor, { withStorageKey: true });

  let storageKey = document.storageKey;
  let name = document.name;
  let mimeType = document.mimeType;
  let size = document.size;
  let servedVersion = document.currentVersion;

  if (version !== undefined && version !== document.currentVersion) {
    assertCanEdit(access);
    const record = await DocumentVersion.findOne({ document: document._id, organization: actor.organization, version })
      .select('+storageKey');
    if (!record) {
      throw new AppError('Version not found', 404, 'NOT_FOUND');
    }
    storageKey = record.storageKey;
    mimeType = record.mimeType;
    size = record.size;
    servedVersion = record.version;
    name = withExtension(`${document.name.replace(/\.[^.]+$/, '')} (v${record.version})`, document.extension);
  }

  const storage = getStorage();
  if (!(await storage.stat(storageKey))) {
    throw new AppError('The file is no longer available', 404, 'FILE_MISSING');
  }

  const inline = disposition === 'inline' && Boolean(ALLOWED_FILE_TYPES[document.extension]?.inline);
  if (!inline) {
    await audit(actor, req, AUDIT_EVENTS.DOCUMENT_DOWNLOADED, document, { version: servedVersion });
  }

  return { stream: storage.createReadStream(storageKey), name, mimeType, size, inline };
}

async function listActivity({ actor, id, page, limit }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanEdit(access);

  const filter = { organization: actor.organization, entityType: 'document', entityId: document._id.toString() };
  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'firstName lastName'),
    AuditLog.countDocuments(filter),
  ]);

  return {
    activity: logs.map((log) => ({
      id: log._id.toString(),
      action: log.action,
      metadata: log.metadata,
      user: log.user ? { id: log.user._id.toString(), fullName: `${log.user.firstName} ${log.user.lastName}`.trim() } : null,
      createdAt: log.createdAt,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

module.exports = {
  createDocument,
  deleteDocument,
  getDocument,
  getDownload,
  listActivity,
  listDocuments,
  moveDocument,
  resolveVisibilityTarget,
  updateDocument,
};
