const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { MAX_FOLDER_DEPTH, MAX_FOLDER_NAME_LENGTH } = require('../constants/document.constants');
const Document = require('../models/Document');
const DocumentFolder = require('../models/DocumentFolder');
const { idOf, isDocumentAdmin, isGuest, isSameId } = require('../utils/documentAccess');
const { logAudit } = require('./audit.service');

const OWNER_POPULATE = 'firstName lastName';
const NAME_COLLATION = { locale: 'en', strength: 2 };
// eslint-disable-next-line no-control-regex
const UNSAFE_FOLDER_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

function sanitizeFolderName(raw) {
  const name = String(raw ?? '')
    .normalize('NFC')
    .replace(UNSAFE_FOLDER_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .trim();
  if (!name) {
    throw new AppError('Folder name is required', 400, 'VALIDATION_ERROR');
  }
  return name;
}

async function findFolder(id, organization, { deleted = false } = {}) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError('Folder not found', 404, 'NOT_FOUND');
  }
  const folder = await DocumentFolder.findOne({
    _id: id,
    organization,
    deletedAt: deleted ? { $ne: null } : null,
  });
  if (!folder) {
    throw new AppError('Folder not found', 404, 'NOT_FOUND');
  }
  return folder;
}

// Folders are org-wide containers (the documents inside are what carry
// access rules), so only the creator or an org admin may change one.
function assertCanModifyFolder(actor, folder) {
  if (!isDocumentAdmin(actor) && !isSameId(actor._id, folder.owner)) {
    throw new AppError('You do not have permission to modify this folder', 403, 'FORBIDDEN');
  }
}

/** Resolves a destination parent (null = root) and returns its ancestor chain. */
async function resolveParent(parentId, organization) {
  if (!parentId) {
    return { parent: null, ancestors: [] };
  }
  const parent = await findFolder(parentId, organization);
  return { parent, ancestors: [...parent.ancestors, parent._id] };
}

async function assertUniqueName(organization, parentId, name, excludeId = null) {
  const filter = { organization, parent: parentId || null, deletedAt: null, name };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }
  const clash = await DocumentFolder.findOne(filter).collation(NAME_COLLATION).select('_id').lean();
  if (clash) {
    throw new AppError('A folder with this name already exists here', 409, 'DUPLICATE_FOLDER_NAME');
  }
}

/**
 * Rewrites `ancestors` for every descendant (active or trashed) after a
 * folder's own ancestor chain changed, so the materialized paths stay valid.
 */
async function rewriteSubtreeAncestors(folder, newAncestors) {
  const descendants = await DocumentFolder.find({ organization: folder.organization, ancestors: folder._id })
    .select('ancestors')
    .lean();
  if (descendants.length === 0) return;

  const operations = descendants.map((descendant) => {
    const index = descendant.ancestors.findIndex((id) => id.toString() === folder._id.toString());
    return {
      updateOne: {
        filter: { _id: descendant._id },
        update: { $set: { ancestors: [...newAncestors, ...descendant.ancestors.slice(index)] } },
      },
    };
  });
  await DocumentFolder.bulkWrite(operations);
}

async function listFolders({ actor, parentId, all }) {
  // Guests never browse the folder tree; they only see documents shared with them.
  if (isGuest(actor)) {
    return { folders: [], breadcrumb: [] };
  }

  const filter = { organization: actor.organization, deletedAt: null };
  let breadcrumb = [];

  if (all) {
    // Hard cap keeps the sidebar tree query bounded.
    const folders = await DocumentFolder.find(filter)
      .collation(NAME_COLLATION)
      .sort({ name: 1 })
      .limit(2000)
      .populate('owner', OWNER_POPULATE);
    return { folders: folders.map((folder) => folder.toSafeObject()), breadcrumb };
  }

  if (parentId && parentId !== 'root') {
    const current = await findFolder(parentId, actor.organization);
    const chain = await DocumentFolder.find({ _id: { $in: current.ancestors }, organization: actor.organization })
      .select('name')
      .lean();
    const byId = new Map(chain.map((item) => [item._id.toString(), item.name]));
    breadcrumb = [
      ...current.ancestors.map((id) => ({ id: id.toString(), name: byId.get(id.toString()) || '…' })),
      { id: current._id.toString(), name: current.name },
    ];
    filter.parent = current._id;
  } else {
    filter.parent = null;
  }

  const folders = await DocumentFolder.find(filter)
    .collation(NAME_COLLATION)
    .sort({ name: 1 })
    .limit(500)
    .populate('owner', OWNER_POPULATE);
  return { folders: folders.map((folder) => folder.toSafeObject()), breadcrumb };
}

async function createFolder({ actor, name, parentId, req }) {
  const cleanName = sanitizeFolderName(name);
  const { parent, ancestors } = await resolveParent(parentId, actor.organization);

  if (ancestors.length + 1 > MAX_FOLDER_DEPTH) {
    throw new AppError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, 400, 'FOLDER_TOO_DEEP');
  }
  await assertUniqueName(actor.organization, parent?._id, cleanName);

  const folder = await DocumentFolder.create({
    organization: actor.organization,
    name: cleanName,
    parent: parent?._id || null,
    ancestors,
    owner: actor._id,
  });

  await logAudit({
    action: AUDIT_EVENTS.FOLDER_CREATED,
    entityId: folder._id.toString(),
    entityType: 'document_folder',
    metadata: { name: folder.name, parent: idOf(parent) },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await folder.populate('owner', OWNER_POPULATE);
  return { folder: folder.toSafeObject() };
}

async function updateFolder({ actor, id, name, parentId, req }) {
  const folder = await findFolder(id, actor.organization);
  assertCanModifyFolder(actor, folder);

  const renaming = name !== undefined && sanitizeFolderName(name) !== folder.name;
  const newName = renaming ? sanitizeFolderName(name) : folder.name;
  const moving = parentId !== undefined && idOf(parentId) !== idOf(folder.parent);

  let destination = { parent: null, ancestors: folder.ancestors };
  if (moving) {
    destination = await resolveParent(parentId, actor.organization);

    // A folder can't go inside itself or any of its own descendants.
    if (
      destination.parent &&
      (isSameId(destination.parent._id, folder._id) ||
        destination.parent.ancestors.some((ancestor) => isSameId(ancestor, folder._id)))
    ) {
      throw new AppError('A folder cannot be moved inside itself', 400, 'INVALID_FOLDER_MOVE');
    }

    const deepest = await DocumentFolder.find({ organization: actor.organization, ancestors: folder._id })
      .select('ancestors')
      .lean();
    const subtreeDepth = deepest.reduce(
      (max, item) => Math.max(max, item.ancestors.length - folder.ancestors.length),
      0,
    );
    if (destination.ancestors.length + 1 + subtreeDepth > MAX_FOLDER_DEPTH) {
      throw new AppError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, 400, 'FOLDER_TOO_DEEP');
    }
  }

  if (!renaming && !moving) {
    await folder.populate('owner', OWNER_POPULATE);
    return { folder: folder.toSafeObject() };
  }

  const targetParentId = moving ? destination.parent?._id || null : folder.parent;
  await assertUniqueName(actor.organization, targetParentId, newName, folder._id);

  const previous = { name: folder.name, parent: idOf(folder.parent) };
  folder.name = newName;
  if (moving) {
    folder.parent = targetParentId;
    folder.ancestors = destination.ancestors;
  }
  await folder.save();
  if (moving) {
    await rewriteSubtreeAncestors(folder, destination.ancestors);
  }

  if (renaming) {
    await logAudit({
      action: AUDIT_EVENTS.FOLDER_RENAMED,
      entityId: folder._id.toString(),
      entityType: 'document_folder',
      metadata: { from: previous.name, to: folder.name },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }
  if (moving) {
    await logAudit({
      action: AUDIT_EVENTS.FOLDER_MOVED,
      entityId: folder._id.toString(),
      entityType: 'document_folder',
      metadata: { name: folder.name, from: previous.parent, to: idOf(folder.parent) },
      organizationId: actor.organization,
      req,
      userId: actor._id,
    });
  }

  await folder.populate('owner', OWNER_POPULATE);
  return { folder: folder.toSafeObject() };
}

/**
 * Soft-deletes a folder and everything inside it. Items trashed by this
 * cascade are tagged `trashedWithFolder` so restoring the folder brings back
 * exactly them. A non-admin may only delete a folder whose whole subtree is
 * their own — deleting would otherwise trash other people's documents.
 */
async function deleteFolder({ actor, id, req }) {
  const folder = await findFolder(id, actor.organization);
  assertCanModifyFolder(actor, folder);

  const descendants = await DocumentFolder.find({
    organization: actor.organization,
    ancestors: folder._id,
    deletedAt: null,
  })
    .select('_id owner')
    .lean();
  const subtreeIds = [folder._id, ...descendants.map((item) => item._id)];

  if (!isDocumentAdmin(actor)) {
    const foreignFolders = descendants.filter((item) => !isSameId(item.owner, actor._id)).length;
    const foreignDocuments = await Document.countDocuments({
      organization: actor.organization,
      folder: { $in: subtreeIds },
      deletedAt: null,
      owner: { $ne: actor._id },
    });
    if (foreignFolders + foreignDocuments > 0) {
      throw new AppError(
        'This folder contains items owned by other people. Ask an administrator to delete it.',
        403,
        'FOLDER_HAS_OTHERS_ITEMS',
      );
    }
  }

  const now = new Date();
  const [documents] = await Promise.all([
    Document.updateMany(
      { organization: actor.organization, folder: { $in: subtreeIds }, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: actor._id, trashedWithFolder: folder._id } },
    ),
    DocumentFolder.updateMany(
      { organization: actor.organization, ancestors: folder._id, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: actor._id, trashedWithFolder: folder._id } },
    ),
  ]);

  folder.deletedAt = now;
  folder.deletedBy = actor._id;
  folder.trashedWithFolder = null;
  await folder.save();

  await logAudit({
    action: AUDIT_EVENTS.FOLDER_DELETED,
    entityId: folder._id.toString(),
    entityType: 'document_folder',
    metadata: {
      name: folder.name,
      subfolders: descendants.length,
      documents: documents.modifiedCount ?? 0,
    },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true, trashedDocuments: documents.modifiedCount ?? 0, trashedFolders: descendants.length };
}

module.exports = {
  assertCanModifyFolder,
  assertUniqueName,
  createFolder,
  deleteFolder,
  findFolder,
  listFolders,
  rewriteSubtreeAncestors,
  updateFolder,
};
