const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { uploadDocumentFile } = require('../middlewares/documentUpload');
const { PERMISSIONS } = require('../constants/permissions');
const controller = require('../controllers/document.controller');
const {
  createFolderSchema,
  downloadQuerySchema,
  listDocumentsQuerySchema,
  listFoldersQuerySchema,
  moveDocumentSchema,
  shareSchema,
  trashQuerySchema,
  updateDocumentSchema,
  updateFolderSchema,
} = require('../validations/document.validation');

const router = express.Router();

router.use(authenticate, requireOrgAccess);

const view = checkPermission(PERMISSIONS.VIEW_DOCUMENT);
const write = checkPermission(PERMISSIONS.UPLOAD_DOCUMENT);
const del = checkPermission(PERMISSIONS.DELETE_DOCUMENT);
const share = checkPermission(PERMISSIONS.SHARE_DOCUMENT);
const purge = checkPermission(PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT);
const folderWrite = checkPermission(PERMISSIONS.CREATE_FOLDER);

// Per-document rules (visibility, ownership, share level, team/project
// membership) are enforced in the services; the middleware above is only the
// coarse role gate. Static paths come before /:id so they are not captured.

// Library
router.get('/', view, validateQuery(listDocumentsQuerySchema), controller.list);
router.post('/', write, uploadDocumentFile, controller.create);

// Folders
router.get('/folders', view, validateQuery(listFoldersQuerySchema), controller.listFolders);
router.post('/folders', folderWrite, validateBody(createFolderSchema), controller.createFolder);
router.patch('/folders/:id', folderWrite, validateBody(updateFolderSchema), controller.updateFolder);
router.delete('/folders/:id', del, controller.deleteFolder);
router.post('/folders/:id/restore', del, controller.restoreFolder);
router.delete('/folders/:id/permanent', purge, controller.permanentlyDeleteFolder);

// Trash
router.get('/trash', del, validateQuery(trashQuerySchema), controller.listTrash);

// Single document
router.get('/:id', view, controller.getById);
router.patch('/:id', write, validateBody(updateDocumentSchema), controller.update);
router.post('/:id/move', write, validateBody(moveDocumentSchema), controller.move);
router.delete('/:id', del, controller.remove);
router.post('/:id/restore', del, controller.restoreDocument);
router.delete('/:id/permanent', purge, controller.permanentlyDeleteDocument);
router.get('/:id/download', view, validateQuery(downloadQuerySchema), controller.download);
router.get('/:id/activity', view, controller.activity);

// Sharing
router.get('/:id/shares', view, controller.listShares);
router.post('/:id/shares', share, validateBody(shareSchema), controller.addShare);
router.delete('/:id/shares/:userId', share, controller.revokeShare);

// Versions
router.get('/:id/versions', view, controller.listVersions);
router.post('/:id/versions', write, uploadDocumentFile, controller.uploadVersion);
router.get('/:id/versions/:version/download', view, controller.downloadVersion);
router.post('/:id/versions/:version/restore', write, controller.restoreVersion);

module.exports = router;
