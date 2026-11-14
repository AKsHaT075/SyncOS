const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const Document = require('../models/Document');
const DocumentFolder = require('../models/DocumentFolder');
const DocumentVersion = require('../models/DocumentVersion');
const { getStorage } = require('../storage');
const { DOCUMENT_VISIBILITY } = require('../constants/document.constants');
const { idOf, isDocumentAdmin, isGuest, isSameId } = require('../utils/documentAccess');
const { assertObjectId, getAccessibleDocument } = require('./documentAccess.service');
const { assertUniqueName, findFolder, rewriteSubtreeAncestors } = require('./documentFolder.service');
const { logAudit } = require('./audit.service');
const ingestion = require('./ai/ingestion');

const NAME_COLLATION = { locale: 'en', strength: 2 };

/**
 * Trash visibility mirrors document privacy: you see what you own or deleted;
 * admins additionally see every non-private document (private ones stay
 * private even in the trash).
 */
function trashScope(actor) {
  const mine = [{ owner: actor._id }, { deletedBy: actor._id }];
  if (!isDocumentAdmin(actor)) {
    return { $or: mine };
  }
  return { $or: [...mine, { visibility: { $ne: DOCUMENT_VISIBILITY.PRIVATE } }] };
}

async function listTrash({ actor, page, limit }) {
  if (isGuest(actor)) {
    return {
      documents: [],
      folders: [],
      pagination: { page, limit, total: 0, pages: 0 },
    };
  }

  // Only top-level trashed items: things trashed *because* a folder was
  // deleted are restored with that folder, not listed individually.
  const documentFilter = {
    organization: actor.organization,
    deletedAt: { $ne: null },
    trashedWithFolder: null,
    ...trashScope(actor),
  };
  const folderFilter = {
    organization: actor.organization,
    deletedAt: { $ne: null },
    trashedWithFolder: null,
    $or: isDocumentAdmin(actor) ? [{}] : [{ owner: actor._id }, { deletedBy: actor._id }],
  };

  const [documents, total, folders] = await Promise.all([
    Document.find(documentFilter)
      .sort({ deletedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('owner', 'firstName lastName email')
      .populate('team', 'name')
      .populate('project', 'name'),
    Document.countDocuments(documentFilter),
    DocumentFolder.find(folderFilter).sort({ deletedAt: -1 }).limit(200).populate('owner', 'firstName lastName'),
  ]);

  return {
    documents: documents.map((document) => document.toSafeObject()),
    folders: folders.map((folder) => folder.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

function assertCanRestore(actor, item) {
  if (!isDocumentAdmin(actor) && !isSameId(actor._id, item.owner) && !isSameId(actor._id, item.deletedBy)) {
    throw new AppError('You do not have permission to restore this item', 403, 'FORBIDDEN');
  }
}

async function restoreDocument({ actor, id, req }) {
  const { document, access } = await getAccessibleDocument(id, actor, { deleted: true });
  assertCanRestore(actor, document);
  // Admins cannot restore (i.e. peek at) someone else's private document.
  if (!access.canView) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  // If its folder is gone or still in the trash, restore to the library root.
  let restoredToRoot = false;
  if (document.folder) {
    const folder = await DocumentFolder.findOne({
      _id: document.folder,
      organization: actor.organization,
      deletedAt: null,
    })
      .select('_id')
      .lean();
    if (!folder) {
      document.folder = null;
      restoredToRoot = true;
    }
  }

  document.deletedAt = null;
  document.deletedBy = null;
  document.trashedWithFolder = null;
  document.updatedBy = actor._id;
  await document.save();
  await ingestion.documentChanged(document._id, actor.organization, 'restore'); // re-index what the trash had un-indexed

  await logAudit({
    action: AUDIT_EVENTS.DOCUMENT_RESTORED,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name, restoredToRoot },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true, restoredToRoot };
}

/**
 * Removes the DB records first, then the blobs. If blob removal fails we are
 * left with an unreachable orphan (harmless, sweepable) rather than a
 * visible record pointing at a missing file.
 */
async function purgeDocuments(organization, documentIds) {
  if (documentIds.length === 0) return 0;

  const versions = await DocumentVersion.find({ organization, document: { $in: documentIds } })
    .select('+storageKey')
    .lean();
  const keys = new Set(versions.map((version) => version.storageKey));

  const documents = await Document.find({ organization, _id: { $in: documentIds } })
    .select('+storageKey')
    .lean();
  documents.forEach((document) => keys.add(document.storageKey));

  await DocumentVersion.deleteMany({ organization, document: { $in: documentIds } });
  await Document.deleteMany({ organization, _id: { $in: documentIds } });
  await ingestion.documentsPurged(organization, documentIds); // extracted text and jobs go with the document

  const storage = getStorage();
  await Promise.all([...keys].map((key) => storage.remove(key).catch(() => {})));
  return documentIds.length;
}

async function permanentlyDeleteDocument({ actor, id, req }) {
  const { document } = await getAccessibleDocument(id, actor, { deleted: true });
  assertCanRestore(actor, document);

  await purgeDocuments(actor.organization, [document._id]);

  await logAudit({
    action: AUDIT_EVENTS.DOCUMENT_PERMANENTLY_DELETED,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });
  return { success: true };
}

async function restoreFolder({ actor, id, req }) {
  const folder = await findFolder(id, actor.organization, { deleted: true });
  assertCanRestore(actor, folder);

  // If the parent is gone or trashed, the folder comes back at the root.
  let ancestors = folder.ancestors;
  let parent = folder.parent;
  let restoredToRoot = false;
  if (folder.parent) {
    const liveParent = await DocumentFolder.findOne({
      _id: folder.parent,
      organization: actor.organization,
      deletedAt: null,
    })
      .select('_id ancestors')
      .lean();
    if (!liveParent) {
      parent = null;
      ancestors = [];
      restoredToRoot = true;
    }
  }

  let { name } = folder;
  try {
    await assertUniqueName(actor.organization, parent, name, folder._id);
  } catch (error) {
    if (error.code !== 'DUPLICATE_FOLDER_NAME') throw error;
    name = `${name} (restored)`;
  }

  const reparented = restoredToRoot;
  folder.name = name;
  folder.parent = parent;
  folder.ancestors = ancestors;
  folder.deletedAt = null;
  folder.deletedBy = null;
  folder.trashedWithFolder = null;
  await folder.save();
  if (reparented) {
    await rewriteSubtreeAncestors(folder, ancestors);
  }

  const restore = { $set: { deletedAt: null, deletedBy: null, trashedWithFolder: null } };
  const [subfolders, documents] = await Promise.all([
    DocumentFolder.updateMany({ organization: actor.organization, trashedWithFolder: folder._id }, restore),
    Document.updateMany({ organization: actor.organization, trashedWithFolder: folder._id }, restore),
  ]);

  await logAudit({
    action: AUDIT_EVENTS.FOLDER_RESTORED,
    entityId: folder._id.toString(),
    entityType: 'document_folder',
    metadata: {
      name: folder.name,
      restoredToRoot,
      subfolders: subfolders.modifiedCount ?? 0,
      documents: documents.modifiedCount ?? 0,
    },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true, restoredToRoot };
}

async function permanentlyDeleteFolder({ actor, id, req }) {
  const folder = await findFolder(id, actor.organization, { deleted: true });
  assertCanRestore(actor, folder);

  const descendants = await DocumentFolder.find({ organization: actor.organization, ancestors: folder._id })
    .select('_id')
    .lean();
  const folderIds = [folder._id, ...descendants.map((item) => item._id)];

  const documents = await Document.find({ organization: actor.organization, folder: { $in: folderIds } })
    .select('_id')
    .lean();
  const purged = await purgeDocuments(
    actor.organization,
    documents.map((document) => document._id),
  );
  await DocumentFolder.deleteMany({ organization: actor.organization, _id: { $in: folderIds } });

  await logAudit({
    action: AUDIT_EVENTS.FOLDER_PERMANENTLY_DELETED,
    entityId: folder._id.toString(),
    entityType: 'document_folder',
    metadata: { name: folder.name, subfolders: descendants.length, documents: purged },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });
  return { success: true };
}

module.exports = {
  listTrash,
  permanentlyDeleteDocument,
  permanentlyDeleteFolder,
  restoreDocument,
  restoreFolder,
};
