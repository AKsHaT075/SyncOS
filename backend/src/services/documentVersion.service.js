const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
const { getStorage, generateStorageKey } = require('../storage');
const { decodeOriginalName, getExtension, inspectUpload } = require('../utils/fileValidation');
const { assertCanEdit, getAccessibleDocument } = require('./documentAccess.service');
const { logAudit } = require('./audit.service');
const notificationEvents = require('./notificationEvents');

const UPLOADER_POPULATE = 'firstName lastName';

/**
 * Atomically reserves the next version number. A counter (not "current + 1")
 * so two concurrent uploads can never be handed the same number, and a failed
 * upload never causes a number to be reused.
 */
async function reserveVersionNumber(document, organization) {
  const updated = await Document.findOneAndUpdate(
    { _id: document._id, organization, deletedAt: null },
    { $inc: { versionSeq: 1 } },
    { new: true },
  ).select('versionSeq');
  if (!updated) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }
  return updated.versionSeq;
}

/** Writes a new version record and points the document at it. */
async function commitVersion({ actor, document, number, storageKey, meta, fileName, changeNote, restoredFrom, req, action }) {
  try {
    await DocumentVersion.create({
      organization: actor.organization,
      document: document._id,
      version: number,
      storageKey,
      fileName,
      mimeType: meta.mimeType,
      size: meta.size,
      checksum: meta.checksum,
      uploadedBy: actor._id,
      changeNote: changeNote || '',
      restoredFrom: restoredFrom ?? null,
    });

    // Only move forward: if a newer version landed meanwhile, keep it as current.
    await Document.updateOne(
      { _id: document._id, organization: actor.organization, currentVersion: { $lt: number } },
      {
        $set: {
          currentVersion: number,
          storageKey,
          mimeType: meta.mimeType,
          size: meta.size,
          checksum: meta.checksum,
          updatedBy: actor._id,
        },
      },
    );
  } catch (error) {
    await DocumentVersion.deleteOne({ document: document._id, version: number }).catch(() => {});
    await getStorage().remove(storageKey).catch(() => {});
    throw error;
  }

  await logAudit({
    action,
    entityId: document._id.toString(),
    entityType: 'document',
    metadata: { name: document.name, version: number, restoredFrom: restoredFrom ?? undefined, size: meta.size },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.documentVersionUploaded({ document, actor, version: number, restored: restoredFrom != null });
}

async function listVersions({ actor, id }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanEdit(access);

  const versions = await DocumentVersion.find({ document: document._id, organization: actor.organization })
    .sort({ version: -1 })
    .populate('uploadedBy', UPLOADER_POPULATE);

  return {
    currentVersion: document.currentVersion,
    versions: versions.map((version) => version.toSafeObject(document.currentVersion)),
  };
}

async function uploadVersion({ actor, id, file, changeNote, req }) {
  if (!file) {
    throw new AppError('A file is required', 400, 'FILE_REQUIRED');
  }
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanEdit(access);

  const originalName = decodeOriginalName(file.originalname);
  // A replacement keeps the document's format, so previews and the file
  // icon never silently change type under existing viewers.
  if (getExtension(originalName) !== document.extension) {
    throw new AppError(`The replacement must be a .${document.extension} file`, 400, 'VERSION_TYPE_MISMATCH');
  }
  const meta = await inspectUpload({ filePath: file.path, originalName, clientMime: file.mimetype });

  const storage = getStorage();
  const storageKey = generateStorageKey(actor.organization);
  await storage.put(storageKey, file.path);

  let number;
  try {
    number = await reserveVersionNumber(document, actor.organization);
  } catch (error) {
    await storage.remove(storageKey).catch(() => {});
    throw error;
  }

  await commitVersion({
    actor,
    document,
    number,
    storageKey,
    meta,
    fileName: originalName,
    changeNote,
    req,
    action: AUDIT_EVENTS.DOCUMENT_VERSION_UPLOADED,
  });

  return { version: number };
}

/**
 * Restoring never rewrites history: the old file is copied to a fresh object
 * and recorded as a NEW version (so every version stays immutable and can be
 * deleted independently).
 */
async function restoreVersion({ actor, id, version, req }) {
  const { document, access } = await getAccessibleDocument(id, actor);
  assertCanEdit(access);

  const source = await DocumentVersion.findOne({ document: document._id, organization: actor.organization, version })
    .select('+storageKey');
  if (!source) {
    throw new AppError('Version not found', 404, 'NOT_FOUND');
  }
  if (version === document.currentVersion) {
    throw new AppError('That version is already the current one', 400, 'VERSION_ALREADY_CURRENT');
  }

  const storage = getStorage();
  if (!(await storage.stat(source.storageKey))) {
    throw new AppError('The file for that version is no longer available', 404, 'FILE_MISSING');
  }

  const storageKey = generateStorageKey(actor.organization);
  await storage.copy(source.storageKey, storageKey);

  let number;
  try {
    number = await reserveVersionNumber(document, actor.organization);
  } catch (error) {
    await storage.remove(storageKey).catch(() => {});
    throw error;
  }

  await commitVersion({
    actor,
    document,
    number,
    storageKey,
    meta: { mimeType: source.mimeType, size: source.size, checksum: source.checksum },
    fileName: source.fileName,
    changeNote: `Restored from version ${version}`,
    restoredFrom: version,
    req,
    action: AUDIT_EVENTS.DOCUMENT_VERSION_RESTORED,
  });

  return { version: number, restoredFrom: version };
}

module.exports = { listVersions, restoreVersion, uploadVersion };
