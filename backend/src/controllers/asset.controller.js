const asyncHandler = require('../utils/async-handler');
const assets = require('../services/asset.service');
const assignments = require('../services/assetAssignment.service');
const catalog = require('../services/assetCatalog.service');
const documents = require('../services/assetDocument.service');
const maintenance = require('../services/assetMaintenance.service');
const reports = require('../services/assetReports.service');

const ok = (res, payload, status = 200) => res.status(status).json({ success: true, ...payload });
const ctx = (req) => ({ actor: req.user, req });
const withId = (req) => ({ ...ctx(req), id: req.params.id });

// assets
const list = asyncHandler(async (req, res) => ok(res, await assets.listAssets({ actor: req.user, query: req.query })));
const create = asyncHandler(async (req, res) => ok(res, await assets.createAsset({ ...ctx(req), body: req.body }), 201));
const getById = asyncHandler(async (req, res) => ok(res, await assets.getAsset({ actor: req.user, id: req.params.id })));
const update = asyncHandler(async (req, res) => ok(res, await assets.updateAsset({ ...withId(req), body: req.body })));
const archive = asyncHandler(async (req, res) => ok(res, await assets.archiveAsset(withId(req))));
const restore = asyncHandler(async (req, res) => ok(res, await assets.restoreAsset(withId(req))));
const options = asyncHandler(async (req, res) => ok(res, await assets.filterOptions({ actor: req.user })));
const activity = asyncHandler(async (req, res) => ok(res, await assets.listActivity({ actor: req.user, id: req.params.id, ...req.query })));

// lifecycle
const reserve = asyncHandler(async (req, res) => ok(res, await assets.reserveAsset({ ...withId(req), note: req.body.note })));
const release = asyncHandler(async (req, res) => ok(res, await assets.releaseAsset({ ...withId(req), note: req.body.note })));
const retire = asyncHandler(async (req, res) => ok(res, await assets.retireAsset({ ...withId(req), note: req.body.note })));
const dispose = asyncHandler(async (req, res) => ok(res, await assets.disposeAsset({ ...withId(req), note: req.body.note })));
const lost = asyncHandler(async (req, res) => ok(res, await assets.markLost({ ...withId(req), note: req.body.note })));
const found = asyncHandler(async (req, res) => ok(res, await assets.markFound({ ...withId(req), ...req.body })));

// assignment
const assign = asyncHandler(async (req, res) => ok(res, await assignments.assignAsset({ ...withId(req), body: req.body }), 201));
const transfer = asyncHandler(async (req, res) => ok(res, await assignments.transferAsset({ ...withId(req), body: req.body })));
const returnIt = asyncHandler(async (req, res) => ok(res, await assignments.returnAsset({ ...withId(req), body: req.body })));
const requestReturn = asyncHandler(async (req, res) => ok(res, await assignments.requestReturn({ ...withId(req), body: req.body })));
const history = asyncHandler(async (req, res) => ok(res, await assignments.listAssetHistory({ actor: req.user, id: req.params.id, ...req.query })));
const listAssignments = asyncHandler(async (req, res) => ok(res, await assignments.listAssignments({ actor: req.user, query: req.query })));
const mine = asyncHandler(async (req, res) => ok(res, await assignments.listMyAssets({ actor: req.user })));
const offboarding = asyncHandler(async (req, res) => ok(res, await assignments.listOffboarding({ actor: req.user })));

// maintenance
const listMaintenance = asyncHandler(async (req, res) => ok(res, await maintenance.listMaintenance({ actor: req.user, query: req.query })));
const assetMaintenance = asyncHandler(async (req, res) => ok(res, await maintenance.listAssetMaintenance({ actor: req.user, id: req.params.id })));
const createMaintenance = asyncHandler(async (req, res) => ok(res, await maintenance.createMaintenance({ ...withId(req), body: req.body }), 201));
const reportIssue = asyncHandler(async (req, res) => ok(res, await maintenance.reportIssue({ ...withId(req), body: req.body }), 201));
const maintenanceAction = (fn) => asyncHandler(async (req, res) =>
  ok(res, await maintenance[fn]({ ...withId(req), maintenanceId: req.params.maintenanceId, body: req.body })));

// documents
const listDocuments = asyncHandler(async (req, res) => ok(res, await documents.listAssetDocuments({ actor: req.user, id: req.params.id, maintenanceId: req.query.maintenanceId })));
const linkDocument = asyncHandler(async (req, res) => ok(res, await documents.linkDocument({ ...withId(req), body: req.body }), 201));
const unlinkDocument = asyncHandler(async (req, res) => ok(res, await documents.unlinkDocument({ ...withId(req), linkId: req.params.linkId })));

// catalog
const listCategories = asyncHandler(async (req, res) => ok(res, await catalog.listCategories({ actor: req.user, includeArchived: req.query.includeArchived === 'true' })));
const createCategory = asyncHandler(async (req, res) => ok(res, await catalog.createCategory({ ...ctx(req), body: req.body }), 201));
const updateCategory = asyncHandler(async (req, res) => ok(res, await catalog.updateCategory({ ...withId(req), body: req.body })));
const archiveCategory = asyncHandler(async (req, res) => ok(res, await catalog.archiveCategory({ ...withId(req), moveTo: req.body.moveTo })));
const listVendors = asyncHandler(async (req, res) => ok(res, await catalog.listVendors({ actor: req.user, search: req.query.search, includeArchived: req.query.includeArchived === 'true' })));
const createVendor = asyncHandler(async (req, res) => ok(res, await catalog.createVendor({ ...ctx(req), body: req.body }), 201));
const updateVendor = asyncHandler(async (req, res) => ok(res, await catalog.updateVendor({ ...withId(req), body: req.body })));
const archiveVendor = asyncHandler(async (req, res) => ok(res, await catalog.archiveVendor(withId(req))));

// reports
const summary = asyncHandler(async (req, res) => ok(res, await reports.getSummary({ actor: req.user, days: req.query.days })));
const exportCsv = asyncHandler(async (req, res) => {
  const csv = await reports.exportCsv({ actor: req.user });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assets-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(`﻿${csv}`);
});

module.exports = {
  activity, archive, archiveCategory, archiveVendor, assetMaintenance, assign, create, createCategory, createMaintenance, createVendor, dispose,
  exportCsv, found, getById, history, linkDocument, list, listAssignments, listCategories, listDocuments, listMaintenance, listVendors, lost, maintenanceAction,
  mine, offboarding, options, release, reportIssue, requestReturn, reserve, restore, retire, returnIt, summary, transfer, unlinkDocument, update,
  updateCategory, updateVendor,
};
