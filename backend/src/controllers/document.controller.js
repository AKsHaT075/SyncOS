const asyncHandler = require('../utils/async-handler');
const AppError = require('../utils/app-error');
const { removeTempFile } = require('../middlewares/documentUpload');
const {
  activityQuerySchema,
  createDocumentSchema,
  uploadVersionSchema,
} = require('../validations/document.validation');
const documents = require('../services/document.service');
const folders = require('../services/documentFolder.service');
const shares = require('../services/documentShare.service');
const trash = require('../services/documentTrash.service');
const versions = require('../services/documentVersion.service');

function parseOrThrow(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', result.error.flatten());
  }
  return result.data;
}

function parseVersionParam(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new AppError('Version not found', 404, 'NOT_FOUND');
  }
  return number;
}

const ok = (res, status, payload) => res.status(status).json({ success: true, ...payload });

// ---- documents -----------------------------------------------------------

const list = asyncHandler(async (req, res) =>
  ok(res, 200, await documents.listDocuments({ actor: req.user, query: req.query })));

const getById = asyncHandler(async (req, res) =>
  ok(res, 200, await documents.getDocument({ actor: req.user, id: req.params.id })));

// Multipart handlers validate their fields *inside* try/finally so the temp
// file is always removed, whether the request succeeds or fails.
const create = asyncHandler(async (req, res) => {
  try {
    const body = parseOrThrow(createDocumentSchema, req.body);
    const result = await documents.createDocument({ actor: req.user, file: req.file, body, req });
    return ok(res, 201, result);
  } finally {
    await removeTempFile(req.file);
  }
});

const update = asyncHandler(async (req, res) =>
  ok(res, 200, await documents.updateDocument({ actor: req.user, id: req.params.id, updates: req.body, req })));

const move = asyncHandler(async (req, res) =>
  ok(res, 200, await documents.moveDocument({ actor: req.user, id: req.params.id, folderId: req.body.folderId, req })));

const remove = asyncHandler(async (req, res) =>
  ok(res, 200, await documents.deleteDocument({ actor: req.user, id: req.params.id, req })));

function sendFile(res, { stream, name, mimeType, size, inline }) {
  res.attachment(name); // builds a safe, RFC 6266-encoded Content-Disposition
  if (inline) {
    res.setHeader('Content-Disposition', res.getHeader('Content-Disposition').replace(/^attachment/, 'inline'));
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  }
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

const download = asyncHandler(async (req, res) => {
  const file = await documents.getDownload({
    actor: req.user,
    id: req.params.id,
    disposition: req.query.disposition,
    req,
  });
  return sendFile(res, file);
});

const activity = asyncHandler(async (req, res) => {
  const { page, limit } = parseOrThrow(activityQuerySchema, req.query);
  return ok(res, 200, await documents.listActivity({ actor: req.user, id: req.params.id, page, limit }));
});

// ---- sharing -------------------------------------------------------------

const listShares = asyncHandler(async (req, res) =>
  ok(res, 200, await shares.listShares({ actor: req.user, id: req.params.id })));

const addShare = asyncHandler(async (req, res) =>
  ok(res, 200, await shares.addShare({ actor: req.user, id: req.params.id, ...req.body, req })));

const revokeShare = asyncHandler(async (req, res) =>
  ok(res, 200, await shares.revokeShare({ actor: req.user, id: req.params.id, userId: req.params.userId, req })));

// ---- versions ------------------------------------------------------------

const listVersions = asyncHandler(async (req, res) =>
  ok(res, 200, await versions.listVersions({ actor: req.user, id: req.params.id })));

const uploadVersion = asyncHandler(async (req, res) => {
  try {
    const { changeNote } = parseOrThrow(uploadVersionSchema, req.body);
    const result = await versions.uploadVersion({
      actor: req.user,
      id: req.params.id,
      file: req.file,
      changeNote,
      req,
    });
    return ok(res, 201, result);
  } finally {
    await removeTempFile(req.file);
  }
});

const downloadVersion = asyncHandler(async (req, res) => {
  const file = await documents.getDownload({
    actor: req.user,
    id: req.params.id,
    version: parseVersionParam(req.params.version),
    disposition: 'attachment',
    req,
  });
  return sendFile(res, file);
});

const restoreVersion = asyncHandler(async (req, res) =>
  ok(res, 200, await versions.restoreVersion({
    actor: req.user,
    id: req.params.id,
    version: parseVersionParam(req.params.version),
    req,
  })));

// ---- trash ---------------------------------------------------------------

const listTrash = asyncHandler(async (req, res) =>
  ok(res, 200, await trash.listTrash({ actor: req.user, ...req.query })));

const restoreDocument = asyncHandler(async (req, res) =>
  ok(res, 200, await trash.restoreDocument({ actor: req.user, id: req.params.id, req })));

const permanentlyDeleteDocument = asyncHandler(async (req, res) =>
  ok(res, 200, await trash.permanentlyDeleteDocument({ actor: req.user, id: req.params.id, req })));

// ---- folders -------------------------------------------------------------

const listFolders = asyncHandler(async (req, res) =>
  ok(res, 200, await folders.listFolders({
    actor: req.user,
    parentId: req.query.parentId,
    all: req.query.all === 'true',
  })));

const createFolder = asyncHandler(async (req, res) =>
  ok(res, 201, await folders.createFolder({ actor: req.user, ...req.body, req })));

const updateFolder = asyncHandler(async (req, res) =>
  ok(res, 200, await folders.updateFolder({ actor: req.user, id: req.params.id, ...req.body, req })));

const deleteFolder = asyncHandler(async (req, res) =>
  ok(res, 200, await folders.deleteFolder({ actor: req.user, id: req.params.id, req })));

const restoreFolder = asyncHandler(async (req, res) =>
  ok(res, 200, await trash.restoreFolder({ actor: req.user, id: req.params.id, req })));

const permanentlyDeleteFolder = asyncHandler(async (req, res) =>
  ok(res, 200, await trash.permanentlyDeleteFolder({ actor: req.user, id: req.params.id, req })));

module.exports = {
  activity,
  addShare,
  create,
  createFolder,
  deleteFolder,
  download,
  downloadVersion,
  getById,
  list,
  listFolders,
  listShares,
  listTrash,
  listVersions,
  move,
  permanentlyDeleteDocument,
  permanentlyDeleteFolder,
  remove,
  restoreDocument,
  restoreFolder,
  restoreVersion,
  revokeShare,
  update,
  updateFolder,
  uploadVersion,
};
