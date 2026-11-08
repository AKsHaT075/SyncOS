const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const {
  ASSET_KIND, ASSET_STATUS, LIMITS, MAINTENANCE_STATUS, MAINTENANCE_TRANSITIONS, MAINTENANCE_TYPE, MAINTENANCE_UPCOMING_DAYS,
} = require('../constants/asset.constants');
const { PERMISSIONS } = require('../constants/permissions');
const Asset = require('../models/Asset');
const AssetMaintenance = require('../models/AssetMaintenance');
const { buildAssetVisibilityFilter, can, canReportIssue, isOrgWide } = require('../utils/assetAccess');
const { dateOnlyString, parseDateOnly } = require('../utils/timezone');
const { loadAssetContext } = require('./assetContext');
const { requireVendor } = require('./assetCatalog.service');
const events = require('./assetEvents');
const { fullName, idOf } = require('./assetPresenter');
const { audit, findViewableAsset } = require('./asset.service');

const DAY_MS = 86400000;
const M = MAINTENANCE_STATUS;
const toDate = (value) => (value ? new Date(parseDateOnly(value)) : null);
const todayUtc = () => parseDateOnly(dateOnlyString(Date.now()));
const day = (date) => (date ? dateOnlyString(new Date(date).getTime()) : null);

function assertTransition(maintenance, to) {
  if (!MAINTENANCE_TRANSITIONS[maintenance.status].includes(to)) {
    throw new AppError(`A ${maintenance.status.toLowerCase().replace(/_/g, ' ')} maintenance record can't be changed to ${to.toLowerCase().replace(/_/g, ' ')}`, 409, 'INVALID_TRANSITION', { from: maintenance.status, to });
  }
}

const POPULATE = [
  { path: 'reportedBy', select: 'firstName lastName' },
  { path: 'decidedBy', select: 'firstName lastName' },
  { path: 'vendor', select: 'name' },
];

function presentMaintenance(doc, viewer, asset = null) {
  const row = doc.toObject ? doc.toObject() : doc;
  const showCost = can(viewer, PERMISSIONS.MANAGE_ASSET_MAINTENANCE) || can(viewer, PERMISSIONS.VIEW_ASSET_REPORTS);
  const today = todayUtc();
  return {
    id: idOf(row._id),
    asset: asset ? { id: idOf(asset._id), name: asset.name, assetId: asset.assetId } : { id: idOf(row.asset) },
    type: row.type,
    status: row.status,
    issue: row.issue,
    serviceProvider: row.serviceProvider,
    vendor: row.vendor && row.vendor.name ? { id: idOf(row.vendor), name: row.vendor.name } : null,
    scheduledDate: day(row.scheduledDate),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    nextMaintenanceDate: day(row.nextMaintenanceDate),
    cost: showCost ? row.cost : undefined,
    currency: row.currency,
    repairNotes: row.repairNotes,
    reportedBy: row.reportedBy && row.reportedBy.firstName ? { id: idOf(row.reportedBy), name: fullName(row.reportedBy) } : null,
    requestedAt: row.requestedAt,
    declineReason: row.declineReason,
    overdue: row.status === M.SCHEDULED && Boolean(row.scheduledDate) && row.scheduledDate.getTime() < today,
    createdAt: row.createdAt,
  };
}

async function loadMaintenance(assetId, maintenanceId, organization) {
  if (!mongoose.isValidObjectId(maintenanceId)) throw new AppError('Maintenance record not found', 404, 'NOT_FOUND');
  const record = await AssetMaintenance.findOne({ _id: maintenanceId, asset: assetId, organization });
  if (!record) throw new AppError('Maintenance record not found', 404, 'NOT_FOUND');
  return record;
}

function assertMaintainable(asset) {
  if (asset.kind === ASSET_KIND.SOFTWARE) throw new AppError('Software licenses have no maintenance', 400, 'NOT_APPLICABLE');
  if ([ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED].includes(asset.status) || asset.deletedAt) {
    throw new AppError('Retired and disposed assets can’t have maintenance', 409, 'ASSET_NOT_MAINTAINABLE');
  }
}

// ---- requests and scheduling ------------------------------------------------------------------------

/** Anyone holding an asset (or with maintenance rights) can report a problem; it waits as REQUESTED for approval. */
async function reportIssue({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  if (!canReportIssue(ctx, asset)) throw new AppError('You can only report problems with equipment you hold', 403, 'FORBIDDEN');
  assertMaintainable(asset);

  const already = await AssetMaintenance.exists({ asset: asset._id, reportedBy: actor._id, status: M.REQUESTED });
  if (already) throw new AppError('You already have an open request for this asset', 409, 'DUPLICATE_REQUEST');

  const record = await AssetMaintenance.create({
    organization: actor.organization, asset: asset._id, type: body.type || MAINTENANCE_TYPE.REPAIR, status: M.REQUESTED, issue: body.issue,
    reportedBy: actor._id, requestedAt: new Date(), createdBy: actor._id,
  });
  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_REQUESTED, asset, { maintenance: idOf(record._id) });
  await events.maintenanceRequested({ asset, actor, maintenance: record });
  return { maintenance: presentMaintenance(record, actor, asset) };
}

async function createMaintenance({ actor, id, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  assertMaintainable(asset);
  await requireVendor(body.vendorId, actor.organization);

  const record = await AssetMaintenance.create({
    organization: actor.organization, asset: asset._id, type: body.type || MAINTENANCE_TYPE.PREVENTIVE, status: M.SCHEDULED, issue: body.issue,
    serviceProvider: body.serviceProvider || '', vendor: body.vendorId || null, scheduledDate: toDate(body.scheduledDate),
    nextMaintenanceDate: toDate(body.nextMaintenanceDate), cost: body.cost ?? null, currency: body.currency, repairNotes: body.repairNotes || '',
    createdBy: actor._id,
  });
  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_SCHEDULED, asset, { maintenance: idOf(record._id), scheduledDate: body.scheduledDate });
  await events.maintenanceScheduled({ asset, actor, maintenance: record });
  return { maintenance: presentMaintenance(record, actor, asset) };
}

async function updateMaintenance({ actor, id, maintenanceId, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const record = await loadMaintenance(asset._id, maintenanceId, actor.organization);
  if ([M.COMPLETED, M.CANCELLED].includes(record.status)) throw new AppError('A finished maintenance record can’t be edited', 409, 'MAINTENANCE_FINISHED');
  if (body.vendorId) await requireVendor(body.vendorId, actor.organization);

  const before = record.scheduledDate?.getTime();
  ['type', 'issue', 'serviceProvider', 'cost', 'currency', 'repairNotes'].forEach((key) => { if (body[key] !== undefined) record[key] = body[key]; });
  if (body.vendorId !== undefined) record.vendor = body.vendorId || null;
  if (body.scheduledDate !== undefined) record.scheduledDate = toDate(body.scheduledDate);
  if (body.nextMaintenanceDate !== undefined) record.nextMaintenanceDate = toDate(body.nextMaintenanceDate);
  record.updatedBy = actor._id;
  await record.save();

  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_SCHEDULED, asset, { maintenance: idOf(record._id), updated: Object.keys(body) });
  if (record.status === M.SCHEDULED && record.scheduledDate?.getTime() !== before) await events.maintenanceScheduled({ asset, actor, maintenance: record });
  return { maintenance: presentMaintenance(record, actor, asset) };
}

async function approveRequest({ actor, id, maintenanceId, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  await requireVendor(body.vendorId, actor.organization);
  const record = await AssetMaintenance.findOneAndUpdate(
    { _id: maintenanceId, asset: asset._id, organization: actor.organization, status: M.REQUESTED },
    { $set: { status: M.SCHEDULED, scheduledDate: toDate(body.scheduledDate), serviceProvider: body.serviceProvider || '', vendor: body.vendorId || null, decidedBy: actor._id, updatedBy: actor._id } },
    { new: true },
  );
  if (!record) {
    const existing = await loadMaintenance(asset._id, maintenanceId, actor.organization);
    assertTransition(existing, M.SCHEDULED);
    throw new AppError('The request changed while you were working', 409, 'CONFLICT');
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_SCHEDULED, asset, { maintenance: idOf(record._id), approved: true });
  await events.maintenanceScheduled({ asset, actor, maintenance: record, extraRecipients: [idOf(record.reportedBy)].filter(Boolean) });
  return { maintenance: presentMaintenance(record, actor, asset) };
}

async function declineRequest({ actor, id, maintenanceId, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const record = await AssetMaintenance.findOneAndUpdate(
    { _id: maintenanceId, asset: asset._id, organization: actor.organization, status: M.REQUESTED },
    { $set: { status: M.CANCELLED, declineReason: body.reason || '', decidedBy: actor._id, updatedBy: actor._id } },
    { new: true },
  );
  if (!record) {
    assertTransition(await loadMaintenance(asset._id, maintenanceId, actor.organization), M.CANCELLED);
    throw new AppError('The request changed while you were working', 409, 'CONFLICT');
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_CANCELLED, asset, { maintenance: idOf(record._id), declined: true });
  await events.maintenanceDeclined({ asset, actor, maintenance: record, note: body.reason });
  return { maintenance: presentMaintenance(record, actor, asset) };
}

// ---- starting and finishing work ----------------------------------------------------------------------

/** The status an asset returns to when work ends: still held → ASSIGNED, otherwise the pool (or RESERVED if it was). */
const restoreStatus = (asset) => (asset.currentAssignment ? ASSET_STATUS.ASSIGNED : asset.statusBeforeMaintenance === ASSET_STATUS.RESERVED ? ASSET_STATUS.RESERVED : ASSET_STATUS.AVAILABLE);

async function startMaintenance({ actor, id, maintenanceId, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  assertMaintainable(asset);
  const record = await loadMaintenance(asset._id, maintenanceId, actor.organization);
  assertTransition(record, M.IN_PROGRESS);

  const holdable = [ASSET_STATUS.AVAILABLE, ASSET_STATUS.ASSIGNED, ASSET_STATUS.RESERVED];
  if (!holdable.includes(asset.status)) throw new AppError(`An asset that is ${asset.status.toLowerCase().replace(/_/g, ' ')} can't go into maintenance`, 409, 'INVALID_TRANSITION');

  // 1. Claim the record (the partial unique index allows one IN_PROGRESS job per asset).
  let started;
  try {
    started = await AssetMaintenance.findOneAndUpdate(
      { _id: record._id, status: M.SCHEDULED },
      { $set: { status: M.IN_PROGRESS, startedAt: new Date(), assetStatusBefore: asset.status, updatedBy: actor._id } },
      { new: true },
    );
  } catch (error) {
    if (error.code === 11000) throw new AppError('Another maintenance job is already in progress for this asset', 409, 'MAINTENANCE_IN_PROGRESS');
    throw error;
  }
  if (!started) throw new AppError('The record changed while you were working', 409, 'CONFLICT');

  // 2. Put the asset under maintenance — conditional on it still being in the status we read.
  const moved = await Asset.findOneAndUpdate(
    { _id: asset._id, organization: actor.organization, deletedAt: null, status: asset.status },
    {
      $set: { status: ASSET_STATUS.UNDER_MAINTENANCE, statusBeforeMaintenance: asset.status, updatedBy: actor._id },
      $push: { statusHistory: { $each: [{ from: asset.status, to: ASSET_STATUS.UNDER_MAINTENANCE, action: 'maintenance-start', by: actor._id, at: new Date() }], $slice: -LIMITS.STATUS_HISTORY } },
    },
    { new: true },
  );
  if (!moved) {
    await AssetMaintenance.updateOne({ _id: record._id, status: M.IN_PROGRESS }, { $set: { status: M.SCHEDULED, startedAt: null, assetStatusBefore: null } }); // undo the claim
    throw new AppError('The asset changed while you were working. Refresh and try again.', 409, 'CONFLICT');
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_MAINTENANCE_STARTED, moved, { maintenance: idOf(record._id) });
  return { maintenance: presentMaintenance(started, actor, moved) };
}

async function finishWork({ actor, asset, record, to, set, req, auditEvent, assetSet = {} }) {
  const done = await AssetMaintenance.findOneAndUpdate(
    { _id: record._id, status: record.status }, { $set: { status: to, updatedBy: actor._id, ...set } }, { new: true },
  );
  if (!done) throw new AppError('The record changed while you were working', 409, 'CONFLICT');

  let updatedAsset = asset;
  if (record.status === M.IN_PROGRESS) {
    const fresh = await Asset.findById(asset._id);
    const to2 = restoreStatus(fresh);
    updatedAsset = (await Asset.findOneAndUpdate(
      { _id: asset._id, status: ASSET_STATUS.UNDER_MAINTENANCE },
      {
        $set: { status: to2, statusBeforeMaintenance: null, updatedBy: actor._id, ...assetSet },
        $push: { statusHistory: { $each: [{ from: ASSET_STATUS.UNDER_MAINTENANCE, to: to2, action: 'maintenance-end', by: actor._id, at: new Date() }], $slice: -LIMITS.STATUS_HISTORY } },
      },
      { new: true },
    )) || fresh;
  }
  await audit(actor, req, auditEvent, updatedAsset, { maintenance: idOf(done._id) });
  return { done, asset: updatedAsset };
}

async function completeMaintenance({ actor, id, maintenanceId, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const record = await loadMaintenance(asset._id, maintenanceId, actor.organization);
  assertTransition(record, M.COMPLETED);

  const completedAt = body.completedDate ? toDate(body.completedDate) : new Date(parseDateOnly(dateOnlyString(Date.now())));
  const nextDate = body.nextMaintenanceDate ? toDate(body.nextMaintenanceDate)
    : asset.maintenance?.intervalDays ? new Date(completedAt.getTime() + asset.maintenance.intervalDays * DAY_MS) : null;

  const { done, asset: updated } = await finishWork({
    actor, asset, record, to: M.COMPLETED, req, auditEvent: AUDIT_EVENTS.ASSET_MAINTENANCE_COMPLETED,
    set: {
      completedAt, nextMaintenanceDate: nextDate,
      ...(body.cost !== undefined ? { cost: body.cost } : {}), ...(body.currency ? { currency: body.currency } : {}),
      ...(body.repairNotes !== undefined ? { repairNotes: body.repairNotes } : {}),
    },
    assetSet: { 'maintenance.lastDate': completedAt, 'maintenance.nextDate': nextDate, ...(body.condition ? { condition: body.condition } : {}) },
  });
  // Work done on a not-in-progress record (e.g. completing straight from SCHEDULED is not allowed) never changes the asset.
  await events.maintenanceCompleted({ asset: updated, actor, maintenance: done });
  return { maintenance: presentMaintenance(done, actor, updated) };
}

async function cancelMaintenance({ actor, id, maintenanceId, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const record = await loadMaintenance(asset._id, maintenanceId, actor.organization);
  assertTransition(record, M.CANCELLED);
  const { done, asset: updated } = await finishWork({
    actor, asset, record, to: M.CANCELLED, req, auditEvent: AUDIT_EVENTS.ASSET_MAINTENANCE_CANCELLED,
    set: { declineReason: body?.reason || '' },
  });
  return { maintenance: presentMaintenance(done, actor, updated) };
}

// ---- reading ---------------------------------------------------------------------------------------------

async function listAssetMaintenance({ actor, id }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const records = await AssetMaintenance.find({ organization: actor.organization, asset: asset._id }).sort({ createdAt: -1 }).limit(200).populate(POPULATE);
  return { maintenance: records.map((record) => presentMaintenance(record, actor, asset)) };
}

/** Organization-wide maintenance, scoped to assets the viewer may see. */
async function listMaintenance({ actor, query }) {
  const ctx = await loadAssetContext(actor);
  const filter = { organization: actor.organization };
  if (!isOrgWide(actor)) {
    const visible = await Asset.find({ organization: actor.organization, deletedAt: null, ...buildAssetVisibilityFilter(ctx) }).select('_id').limit(5000).lean();
    filter.asset = { $in: visible.map((asset) => asset._id) };
  }
  if (query.assetId) filter.asset = query.assetId;
  if (query.status?.length) filter.status = { $in: query.status };

  const today = todayUtc();
  if (query.view === 'upcoming') Object.assign(filter, { status: M.SCHEDULED, scheduledDate: { $gte: new Date(today), $lte: new Date(today + MAINTENANCE_UPCOMING_DAYS * DAY_MS) } });
  if (query.view === 'overdue') Object.assign(filter, { status: M.SCHEDULED, scheduledDate: { $lt: new Date(today) } });
  if (query.view === 'requests') filter.status = M.REQUESTED;
  if (query.from || query.to) {
    filter.scheduledDate = { ...(filter.scheduledDate || {}), ...(query.from ? { $gte: toDate(query.from) } : {}), ...(query.to ? { $lte: toDate(query.to) } : {}) };
  }

  const sort = query.view === 'requests' ? { requestedAt: -1 } : { scheduledDate: 1, createdAt: -1 };
  const [records, total] = await Promise.all([
    AssetMaintenance.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).populate(POPULATE).populate({ path: 'asset', select: 'name assetId' }),
    AssetMaintenance.countDocuments(filter),
  ]);
  return {
    maintenance: records.map((record) => presentMaintenance(record, actor, record.asset && record.asset.name ? record.asset : null)),
    pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
  };
}

module.exports = {
  approveRequest, cancelMaintenance, completeMaintenance, createMaintenance, declineRequest, listAssetMaintenance, listMaintenance,
  presentMaintenance, reportIssue, startMaintenance, updateMaintenance,
};
