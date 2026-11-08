const express = require('express');
const { validateBody, validateQuery } = require('../middlewares/validate.middleware');
const { authenticate, requireOrgAccess } = require('../middlewares/authenticate');
const checkPermission = require('../middlewares/checkPermission');
const { PERMISSIONS: P } = require('../constants/permissions');
const c = require('../controllers/asset.controller');
const v = require('../validations/asset.validation');

const router = express.Router();

// Capability = permission middleware; DATA scope (which assets, which people) is enforced per resource in the
// services via utils/assetAccess.js. Static paths come before /:id so they aren't captured by it.
router.use(authenticate, requireOrgAccess);

router.get('/', checkPermission(P.VIEW_ASSETS), validateQuery(v.listAssetsQuerySchema), c.list);
router.post('/', checkPermission(P.CREATE_ASSET), validateBody(v.createAssetSchema), c.create);
router.get('/mine', checkPermission(P.VIEW_OWN_ASSETS), c.mine);
router.get('/summary', checkPermission(P.VIEW_ASSETS), validateQuery(v.summaryQuerySchema), c.summary);
router.get('/export', checkPermission(P.VIEW_ASSET_REPORTS), c.exportCsv);
router.get('/options', checkPermission(P.VIEW_ASSETS), c.options);
router.get('/offboarding', checkPermission(P.VIEW_ASSETS), c.offboarding);
router.get('/assignments', checkPermission(P.VIEW_ASSETS), validateQuery(v.listAssignmentsQuerySchema), c.listAssignments);
router.get('/maintenance', checkPermission(P.VIEW_ASSETS), validateQuery(v.listMaintenanceQuerySchema), c.listMaintenance);

router.get('/categories', checkPermission(P.VIEW_ASSETS), validateQuery(v.listCatalogQuerySchema), c.listCategories);
router.post('/categories', checkPermission(P.MANAGE_ASSET_CATEGORIES), validateBody(v.categorySchema), c.createCategory);
router.patch('/categories/:id', checkPermission(P.MANAGE_ASSET_CATEGORIES), validateBody(v.updateCategorySchema), c.updateCategory);
router.post('/categories/:id/archive', checkPermission(P.MANAGE_ASSET_CATEGORIES), validateBody(v.archiveCategorySchema), c.archiveCategory);

router.get('/vendors', checkPermission(P.VIEW_ASSETS), validateQuery(v.listCatalogQuerySchema), c.listVendors);
router.post('/vendors', checkPermission(P.MANAGE_ASSET_VENDORS), validateBody(v.vendorSchema), c.createVendor);
router.patch('/vendors/:id', checkPermission(P.MANAGE_ASSET_VENDORS), validateBody(v.updateVendorSchema), c.updateVendor);
router.delete('/vendors/:id', checkPermission(P.MANAGE_ASSET_VENDORS), c.archiveVendor);

router.get('/:id', checkPermission(P.VIEW_OWN_ASSETS), c.getById);
router.patch('/:id', checkPermission(P.UPDATE_ASSET), validateBody(v.updateAssetSchema), c.update);
router.delete('/:id', checkPermission(P.DELETE_ASSET), c.archive);
router.post('/:id/restore', checkPermission(P.DELETE_ASSET), c.restore);

router.post('/:id/assign', checkPermission(P.ASSIGN_ASSET), validateBody(v.assignSchema), c.assign);
router.post('/:id/transfer', checkPermission(P.TRANSFER_ASSET), validateBody(v.transferSchema), c.transfer);
router.post('/:id/return', checkPermission(P.RETURN_ASSET), validateBody(v.returnSchema), c.returnIt);
router.post('/:id/request-return', checkPermission(P.RETURN_ASSET), validateBody(v.requestReturnSchema), c.requestReturn);

router.post('/:id/reserve', checkPermission(P.UPDATE_ASSET), validateBody(v.noteSchema), c.reserve);
router.post('/:id/release', checkPermission(P.UPDATE_ASSET), validateBody(v.noteSchema), c.release);
router.post('/:id/retire', checkPermission(P.UPDATE_ASSET), validateBody(v.noteSchema), c.retire);
router.post('/:id/dispose', checkPermission(P.UPDATE_ASSET), validateBody(v.noteSchema), c.dispose);
router.post('/:id/lost', checkPermission(P.UPDATE_ASSET), validateBody(v.noteSchema), c.lost);
router.post('/:id/found', checkPermission(P.UPDATE_ASSET), validateBody(v.foundSchema), c.found);

router.get('/:id/assignments', checkPermission(P.VIEW_ASSETS), validateQuery(v.pageQuerySchema), c.history);
router.get('/:id/activity', checkPermission(P.VIEW_ASSETS), validateQuery(v.pageQuerySchema), c.activity);

router.get('/:id/maintenance', checkPermission(P.VIEW_OWN_ASSETS), c.assetMaintenance);
router.post('/:id/maintenance', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.createMaintenanceSchema), c.createMaintenance);
router.post('/:id/report-issue', checkPermission(P.VIEW_OWN_ASSETS), validateBody(v.reportIssueSchema), c.reportIssue);
router.patch('/:id/maintenance/:maintenanceId', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.updateMaintenanceSchema), c.maintenanceAction('updateMaintenance'));
router.post('/:id/maintenance/:maintenanceId/approve', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.approveMaintenanceSchema), c.maintenanceAction('approveRequest'));
router.post('/:id/maintenance/:maintenanceId/decline', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.declineMaintenanceSchema), c.maintenanceAction('declineRequest'));
router.post('/:id/maintenance/:maintenanceId/start', checkPermission(P.MANAGE_ASSET_MAINTENANCE), c.maintenanceAction('startMaintenance'));
router.post('/:id/maintenance/:maintenanceId/complete', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.completeMaintenanceSchema), c.maintenanceAction('completeMaintenance'));
router.post('/:id/maintenance/:maintenanceId/cancel', checkPermission(P.MANAGE_ASSET_MAINTENANCE), validateBody(v.declineMaintenanceSchema), c.maintenanceAction('cancelMaintenance'));

router.get('/:id/documents', checkPermission(P.VIEW_OWN_ASSETS), c.listDocuments);
router.post('/:id/documents', checkPermission(P.VIEW_ASSETS), validateBody(v.linkDocumentSchema), c.linkDocument);
router.delete('/:id/documents/:linkId', checkPermission(P.VIEW_ASSETS), c.unlinkDocument);

module.exports = router;
