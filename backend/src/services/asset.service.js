const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const {
  ASSET_KIND, ASSET_STATUS, ASSET_TRANSITIONS, ASSIGNMENT_STATUS, CLOSE_REASON, DEFAULT_CURRENCY, LIMITS, MAINTENANCE_UPCOMING_DAYS,
} = require('../constants/asset.constants');
const { PERMISSIONS } = require('../constants/permissions');
const Asset = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');
const AssetCounter = require('../models/AssetCounter');
const AuditLog = require('../models/AuditLog');
const Team = require('../models/Team');
const User = require('../models/User');
const { buildAssetVisibilityFilter, can, canViewAsset } = require('../utils/assetAccess');
const { dateOnlyString, parseDateOnly } = require('../utils/timezone');
const { logAudit } = require('./audit.service');
const { loadAssetContext } = require('./assetContext');
const { requireActiveCategory, requireVendor, ensureDefaultCategories } = require('./assetCatalog.service');
const events = require('./assetEvents');
const { ASSET_POPULATE, idOf, presentAsset } = require('./assetPresenter');

const DAY_MS = 86400000;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const todayUtc = () => parseDateOnly(dateOnlyString(Date.now()));
const toDate = (value) => (value ? new Date(parseDateOnly(value)) : null);

const audit = (actor, req, action, asset, metadata = {}) =>
  logAudit({
    action, entityId: asset._id.toString(), entityType: 'asset',
    metadata: { name: asset.name, assetId: asset.assetId, ...metadata }, organizationId: actor.organization, req, userId: actor._id,
  });

async function nextAssetId(organization) {
  const counter = await AssetCounter.findOneAndUpdate({ organization }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `AST-${String(counter.seq).padStart(6, '0')}`;
}

function assertId(id, label = 'Asset') {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
}

function duplicateError(error) {
  if (error.code !== 11000) return error;
  const field = Object.keys(error.keyPattern || {}).find((key) => key !== 'organization') || '';
  const label = { assetTag: 'asset tag', serialNumber: 'serial number', assetId: 'asset ID' }[field] || 'value';
  return new AppError(`An asset with this ${label} already exists`, 409, 'DUPLICATE_ASSET', { field });
}

async function assertTeam(teamId, organization) {
  if (!teamId) return null;
  assertId(teamId, 'Team');
  const team = await Team.findOne({ _id: teamId, organization }).select('_id').lean();
  if (!team) throw new AppError('Team not found', 404, 'NOT_FOUND');
  return team;
}

/**
 * Loads an asset in the actor's organization and checks they may SEE it. An asset outside their scope
 * (another team's, another organization's) is reported as missing, never forbidden.
 */
async function findViewableAsset(id, actor, { ctx = null, includeArchived = false, populate = true } = {}) {
  assertId(id);
  let query = Asset.findOne({ _id: id, organization: actor.organization, ...(includeArchived ? {} : { deletedAt: null }) });
  if (populate) ASSET_POPULATE.forEach((entry) => { query = query.populate(entry); });
  const asset = await query;
  if (!asset) throw new AppError('Asset not found', 404, 'NOT_FOUND');
  const context = ctx || (await loadAssetContext(actor));
  if (!canViewAsset(context, asset)) throw new AppError('Asset not found', 404, 'NOT_FOUND');
  return { asset, ctx: context };
}

// ---- create / read / update ------------------------------------------------------------------

function buildLicense(license, existing = null) {
  const next = { ...(existing ? existing.toObject() : {}) };
  const set = (key, value) => { if (value !== undefined) next[key] = value; };
  set('licenseType', license.licenseType);
  set('seats', license.seats);
  set('autoRenew', license.autoRenew);
  set('cost', license.cost);
  set('currency', license.currency);
  set('keyReference', license.keyReference);
  ['startDate', 'expiryDate', 'renewalDate'].forEach((key) => { if (license[key] !== undefined) next[key] = toDate(license[key]); });
  if (next.allocatedSeats === undefined) next.allocatedSeats = 0;
  return next;
}

async function createAsset({ actor, body, req }) {
  await ensureDefaultCategories(actor.organization);
  await requireActiveCategory(body.categoryId, actor.organization);
  await requireVendor(body.purchase?.vendorId, actor.organization);
  await assertTeam(body.teamId, actor.organization);

  const asset = new Asset({
    organization: actor.organization,
    assetId: await nextAssetId(actor.organization),
    assetTag: body.assetTag || undefined,
    name: body.name,
    kind: body.kind,
    category: body.categoryId,
    subcategory: body.subcategory || '',
    description: body.description || '',
    brand: body.brand || '',
    model: body.model || '',
    manufacturer: body.manufacturer || '',
    serialNumber: body.serialNumber || undefined,
    purchase: {
      date: toDate(body.purchase?.date), cost: body.purchase?.cost ?? null, currency: body.purchase?.currency || DEFAULT_CURRENCY,
      vendor: body.purchase?.vendorId || null, invoiceReference: body.purchase?.invoiceReference || '', purchaseOrderReference: body.purchase?.purchaseOrderReference || '',
    },
    condition: body.condition,
    location: body.location || '',
    team: body.teamId || null,
    warranty: { startDate: toDate(body.warranty?.startDate), expiryDate: toDate(body.warranty?.expiryDate) },
    maintenance: {
      intervalDays: body.maintenanceIntervalDays ?? null, nextDate: toDate(body.nextMaintenanceDate),
    },
    license: body.kind === ASSET_KIND.SOFTWARE ? buildLicense(body.license) : null,
    notes: body.notes || '',
    statusHistory: [{ from: null, to: ASSET_STATUS.AVAILABLE, action: 'created', by: actor._id, at: new Date() }],
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  try {
    await asset.save();
  } catch (error) {
    throw duplicateError(error);
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_CREATED, asset, { kind: asset.kind });

  const ctx = await loadAssetContext(actor);
  const fresh = await populated(asset._id);
  return { asset: presentAsset(fresh, ctx) };
}

async function populated(id) {
  let query = Asset.findById(id);
  ASSET_POPULATE.forEach((entry) => { query = query.populate(entry); });
  return query;
}

async function getAsset({ actor, id }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { includeArchived: can(actor, PERMISSIONS.DELETE_ASSET) });
  return { asset: presentAsset(asset, ctx) };
}

async function updateAsset({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  if (asset.status === ASSET_STATUS.DISPOSED) throw new AppError('A disposed asset can no longer be edited', 409, 'ASSET_DISPOSED');

  if (body.categoryId) await requireActiveCategory(body.categoryId, actor.organization);
  if (body.purchase?.vendorId) await requireVendor(body.purchase.vendorId, actor.organization);
  if (body.teamId) await assertTeam(body.teamId, actor.organization);

  const changed = [];
  const set = (path, value) => { asset.set(path, value); changed.push(path); };

  ['name', 'subcategory', 'description', 'brand', 'model', 'manufacturer', 'location', 'notes', 'condition'].forEach((key) => {
    if (body[key] !== undefined) set(key, body[key]);
  });
  if (body.serialNumber !== undefined) set('serialNumber', body.serialNumber || undefined);
  if (body.assetTag !== undefined) set('assetTag', body.assetTag || undefined);
  if (body.categoryId) set('category', body.categoryId);
  if (body.teamId !== undefined) set('team', body.teamId || null);
  if (body.maintenanceIntervalDays !== undefined) set('maintenance.intervalDays', body.maintenanceIntervalDays);
  if (body.nextMaintenanceDate !== undefined) set('maintenance.nextDate', toDate(body.nextMaintenanceDate));
  if (body.purchase) {
    const p = body.purchase;
    if (p.date !== undefined) set('purchase.date', toDate(p.date));
    if (p.cost !== undefined) set('purchase.cost', p.cost);
    if (p.currency) set('purchase.currency', p.currency);
    if (p.vendorId !== undefined) set('purchase.vendor', p.vendorId || null);
    if (p.invoiceReference !== undefined) set('purchase.invoiceReference', p.invoiceReference);
    if (p.purchaseOrderReference !== undefined) set('purchase.purchaseOrderReference', p.purchaseOrderReference);
  }
  if (body.warranty) {
    if (body.warranty.startDate !== undefined) set('warranty.startDate', toDate(body.warranty.startDate));
    if (body.warranty.expiryDate !== undefined) set('warranty.expiryDate', toDate(body.warranty.expiryDate));
    if (asset.warranty.startDate && asset.warranty.expiryDate && asset.warranty.expiryDate < asset.warranty.startDate) {
      throw new AppError('The warranty must end after it starts', 400, 'INVALID_DATE_RANGE');
    }
  }

  let licenseChanged = false;
  if (body.license) {
    if (asset.kind !== ASSET_KIND.SOFTWARE) throw new AppError('Only software assets have a license', 400, 'NOT_SOFTWARE');
    if (!can(actor, PERMISSIONS.MANAGE_ASSET_LICENSES)) throw new AppError('You do not have permission to change license details', 403, 'FORBIDDEN');
    if (body.license.seats !== undefined && body.license.seats < asset.license.allocatedSeats) {
      throw new AppError(`${asset.license.allocatedSeats} seats are in use; reduce assignments first`, 409, 'SEATS_IN_USE');
    }
    asset.license = buildLicense(body.license, asset.license);
    if (asset.license.startDate && asset.license.expiryDate && asset.license.expiryDate < asset.license.startDate) {
      throw new AppError('The license must end after it starts', 400, 'INVALID_DATE_RANGE');
    }
    asset.markModified('license');
    licenseChanged = true;
  }

  asset.updatedBy = actor._id;
  try {
    await asset.save();
  } catch (error) {
    throw duplicateError(error);
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_UPDATED, asset, { fields: changed });
  if (licenseChanged) await audit(actor, req, AUDIT_EVENTS.ASSET_LICENSE_UPDATED, asset, { fields: Object.keys(body.license) }); // never logs the reference value

  return { asset: presentAsset(await populated(asset._id), ctx) };
}

/** "Delete" = archive: history, assignments and documents are kept. Held, in-repair and licensed-seat assets can't be archived. */
async function archiveAsset({ actor, id, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const busy = await AssetAssignment.exists({ asset: asset._id, status: ASSIGNMENT_STATUS.ACTIVE });
  if (busy || [ASSET_STATUS.ASSIGNED, ASSET_STATUS.UNDER_MAINTENANCE].includes(asset.status)) {
    throw new AppError('Return the asset (and finish any maintenance) before archiving it', 409, 'ASSET_IN_USE');
  }
  asset.deletedAt = new Date();
  asset.deletedBy = actor._id;
  await asset.save();
  await audit(actor, req, AUDIT_EVENTS.ASSET_ARCHIVED, asset);
  return { success: true };
}

async function restoreAsset({ actor, id, req }) {
  const { asset } = await findViewableAsset(id, actor, { includeArchived: true, populate: false });
  if (!asset.deletedAt) return { success: true };
  asset.deletedAt = null;
  asset.deletedBy = null;
  await asset.save();
  await audit(actor, req, AUDIT_EVENTS.ASSET_RESTORED, asset);
  return { success: true };
}

// ---- listing ---------------------------------------------------------------------------------

/** Holders who are no longer active members of the organization (left, deactivated or blocked). */
async function formerHolderAssignments(organization) {
  const active = await AssetAssignment.find({ organization, status: ASSIGNMENT_STATUS.ACTIVE, user: { $ne: null } })
    .select('asset user assignedAt').lean();
  if (!active.length) return [];
  const userIds = [...new Set(active.map((entry) => idOf(entry.user)))];
  const members = await User.find({ _id: { $in: userIds }, organization, isActive: true, orgBlocked: { $ne: true } }).select('_id').lean();
  const stillMembers = new Set(members.map((m) => idOf(m._id)));
  return active.filter((entry) => !stillMembers.has(idOf(entry.user)));
}

const SORTS = {
  name: 'name', assetId: 'assetId', createdAt: 'createdAt', purchaseDate: 'purchase.date',
  warrantyExpiry: 'warranty.expiryDate', status: 'status', cost: 'purchase.cost',
};

async function buildListFilter(actor, ctx, query) {
  const and = [{ organization: actor.organization }, buildAssetVisibilityFilter(ctx)];
  const archived = query.includeArchived === 'true' && can(actor, PERMISSIONS.DELETE_ASSET);
  and.push(archived ? { deletedAt: { $ne: null } } : { deletedAt: null });

  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), 'i');
    and.push({ $or: [{ name: regex }, { assetId: regex }, { assetTag: regex }, { serialNumber: regex }, { brand: regex }, { model: regex }] });
  }
  if (query.categoryId) and.push({ category: query.categoryId });
  if (query.status?.length) and.push({ status: { $in: query.status } });
  if (query.kind) and.push({ kind: query.kind });
  if (query.assignedUserId) and.push({ assignedUser: query.assignedUserId });
  if (query.teamId) and.push({ team: query.teamId });
  if (query.holderTeamId) and.push({ assignedTeam: query.holderTeamId });
  if (query.location) and.push({ location: new RegExp(`^${escapeRegex(query.location)}$`, 'i') });
  if (query.purchasedFrom || query.purchasedTo) {
    and.push({ 'purchase.date': { ...(query.purchasedFrom ? { $gte: toDate(query.purchasedFrom) } : {}), ...(query.purchasedTo ? { $lte: toDate(query.purchasedTo) } : {}) } });
  }

  const today = todayUtc();
  if (query.warranty === 'active') and.push({ 'warranty.expiryDate': { $gte: new Date(today) } });
  if (query.warranty === 'expiring') and.push({ 'warranty.expiryDate': { $gte: new Date(today), $lte: new Date(today + 30 * DAY_MS) } });
  if (query.warranty === 'expired') and.push({ 'warranty.expiryDate': { $lt: new Date(today) } });
  if (query.warranty === 'none') and.push({ 'warranty.expiryDate': null });

  const live = { status: { $nin: [ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED] } };
  if (query.maintenance === 'in_progress') and.push({ status: ASSET_STATUS.UNDER_MAINTENANCE });
  if (query.maintenance === 'overdue') and.push({ ...live, 'maintenance.nextDate': { $lt: new Date(today) } });
  if (query.maintenance === 'due_soon') and.push({ ...live, 'maintenance.nextDate': { $gte: new Date(today), $lte: new Date(today + MAINTENANCE_UPCOMING_DAYS * DAY_MS) } });

  if (query.holder === 'unassigned') and.push({ assignedUser: null, assignedTeam: null, kind: ASSET_KIND.HARDWARE });
  if (query.holder === 'former') {
    const former = await formerHolderAssignments(actor.organization);
    and.push({ _id: { $in: former.map((entry) => entry.asset) } });
  }
  return { $and: and };
}

async function listAssets({ actor, query }) {
  const ctx = await loadAssetContext(actor);
  const filter = await buildListFilter(actor, ctx, query);
  const direction = query.sortOrder === 'asc' ? 1 : -1;
  const sort = { [SORTS[query.sortBy]]: direction, _id: direction };

  let find = Asset.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit);
  ASSET_POPULATE.forEach((entry) => { find = find.populate(entry); });
  if (query.sortBy === 'name' || query.sortBy === 'assetId') find = find.collation({ locale: 'en', strength: 2, numericOrdering: true });

  const [assets, total] = await Promise.all([find, Asset.countDocuments(filter)]);
  return {
    assets: assets.map((asset) => presentAsset(asset, ctx)),
    pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
  };
}

async function filterOptions({ actor }) {
  const ctx = await loadAssetContext(actor);
  const scope = { organization: actor.organization, deletedAt: null, ...buildAssetVisibilityFilter(ctx) };
  const locations = await Asset.distinct('location', { ...scope, location: { $ne: '' } });
  return { locations: locations.sort((a, b) => a.localeCompare(b)) };
}

// ---- guarded lifecycle actions (everything except assign / transfer / return / maintenance) ----

const transitionSources = (to) => Object.keys(ASSET_TRANSITIONS).filter((from) => ASSET_TRANSITIONS[from].includes(to));

/**
 * Moves an asset to `to` using ONE conditional atomic update: it only applies if the asset is still in an allowed
 * source status (and `extraFilter` holds). A concurrent change makes it match nothing → 409, never a silent override.
 */
async function guardedTransition({ actor, id, to, action, from, note = '', set = {}, extraFilter = {}, req, auditEvent = AUDIT_EVENTS.ASSET_STATUS_CHANGED }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const allowedFrom = (from || transitionSources(to)).filter((status) => transitionSources(to).includes(status));
  if (!allowedFrom.includes(asset.status)) {
    throw new AppError(`An asset that is ${asset.status.toLowerCase().replace(/_/g, ' ')} can't be changed to ${to.toLowerCase().replace(/_/g, ' ')}`, 409, 'INVALID_TRANSITION', { from: asset.status, to });
  }

  const updated = await Asset.findOneAndUpdate(
    { _id: asset._id, organization: actor.organization, deletedAt: null, status: { $in: allowedFrom }, ...extraFilter },
    {
      $set: { status: to, updatedBy: actor._id, ...set },
      $push: { statusHistory: { $each: [{ from: asset.status, to, action, by: actor._id, at: new Date(), note }], $slice: -LIMITS.STATUS_HISTORY } },
    },
    { new: true },
  );
  if (!updated) throw new AppError('The asset changed while you were working. Refresh and try again.', 409, 'CONFLICT');
  await audit(actor, req, auditEvent, updated, { action, from: asset.status, to, note });
  return updated;
}

const present = async (asset, actor) => ({ asset: presentAsset(await populated(asset._id), await loadAssetContext(actor)) });

const reserveAsset = async ({ actor, id, note, req }) =>
  present(await guardedTransition({ actor, id, to: ASSET_STATUS.RESERVED, action: 'reserve', from: [ASSET_STATUS.AVAILABLE], note, req, extraFilter: { currentAssignment: null } }), actor);

const releaseAsset = async ({ actor, id, note, req }) =>
  present(await guardedTransition({ actor, id, to: ASSET_STATUS.AVAILABLE, action: 'release', from: [ASSET_STATUS.RESERVED], note, req }), actor);

const retireAsset = async ({ actor, id, note, req }) => {
  // A held asset must be returned first; a license with seats in use must have them released.
  const { asset: current } = await findViewableAsset(id, actor, { populate: false });
  if (current.currentAssignment || current.license?.allocatedSeats > 0) {
    throw new AppError('Return the asset (or release every license seat) before retiring it', 409, 'ASSET_IN_USE');
  }
  const updated = await guardedTransition({
    actor, id, to: ASSET_STATUS.RETIRED, action: 'retire', note, req,
    from: [ASSET_STATUS.AVAILABLE, ASSET_STATUS.UNDER_MAINTENANCE, ASSET_STATUS.LOST],
    extraFilter: { currentAssignment: null, $or: [{ 'license.allocatedSeats': 0 }, { license: null }] },
  });
  return present(updated, actor);
};

const disposeAsset = async ({ actor, id, note, req }) =>
  present(await guardedTransition({ actor, id, to: ASSET_STATUS.DISPOSED, action: 'dispose', from: [ASSET_STATUS.RETIRED], note, req }), actor);

const markFound = async ({ actor, id, note, condition, req }) =>
  present(await guardedTransition({ actor, id, to: ASSET_STATUS.AVAILABLE, action: 'found', from: [ASSET_STATUS.LOST], note, req, set: condition ? { condition } : {} }), actor);

/** Reporting a held asset lost ends the holder's assignment (as LOST) so history stays accurate, then flips the status. */
async function markLost({ actor, id, note, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  if (asset.kind === ASSET_KIND.SOFTWARE) throw new AppError('Software licenses cannot be lost', 400, 'NOT_APPLICABLE');
  if (!can(actor, PERMISSIONS.UPDATE_ASSET)) throw new AppError('You do not have permission to do this', 403, 'FORBIDDEN');

  const closed = asset.currentAssignment
    ? await AssetAssignment.findOneAndUpdate(
      { _id: asset.currentAssignment, status: ASSIGNMENT_STATUS.ACTIVE },
      { $set: { status: ASSIGNMENT_STATUS.CLOSED, closeReason: CLOSE_REASON.LOST, closedAt: new Date(), closedBy: actor._id, returnNotes: note || 'Reported lost' } },
      { new: true },
    )
    : null;

  const updated = await guardedTransition({
    actor, id, to: ASSET_STATUS.LOST, action: 'lost', from: [ASSET_STATUS.AVAILABLE, ASSET_STATUS.ASSIGNED], note, req,
    set: { assignedUser: null, assignedTeam: null, currentAssignment: null },
  });
  await events.lost({ asset: updated, actor });
  void closed;
  return present(updated, actor);
}

// ---- activity ---------------------------------------------------------------------------------

async function listActivity({ actor, id, page = 1, limit = 20 }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  if (!can(actor, PERMISSIONS.VIEW_ASSETS)) throw new AppError('You do not have permission to view the activity', 403, 'FORBIDDEN');
  const filter = { organization: actor.organization, entityType: 'asset', entityId: asset._id.toString() };
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'firstName lastName').lean(),
    AuditLog.countDocuments(filter),
  ]);
  return {
    activity: logs.map((log) => ({
      id: idOf(log._id), action: log.action, createdAt: log.createdAt,
      user: log.user ? { id: idOf(log.user), name: `${log.user.firstName} ${log.user.lastName}`.trim() } : null,
      metadata: Object.fromEntries(Object.entries(log.metadata || {}).filter(([key]) => !/key|secret|reference/i.test(key))),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

module.exports = {
  archiveAsset, audit, createAsset, disposeAsset, filterOptions, findViewableAsset, formerHolderAssignments, getAsset, guardedTransition,
  listActivity, listAssets, markFound, markLost, populated, releaseAsset, reserveAsset, restoreAsset, retireAsset, updateAsset,
};
