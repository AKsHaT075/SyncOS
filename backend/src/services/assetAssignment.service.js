const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const {
  ASSET_CONDITION, ASSET_KIND, ASSET_STATUS, ASSIGNEE_TYPE, ASSIGNMENT_STATUS, CLOSE_REASON, LIMITS,
} = require('../constants/asset.constants');
const { PERMISSIONS } = require('../constants/permissions');
const Asset = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');
const Team = require('../models/Team');
const User = require('../models/User');
const { canAssignTo, canReturnFrom, canTransferTo, can, isOrgWide } = require('../utils/assetAccess');
const { dateOnlyString, parseDateOnly } = require('../utils/timezone');
const { loadAssetContext } = require('./assetContext');
const events = require('./assetEvents');
const { ASSET_POPULATE, fullName, idOf, isFormerMember, presentAsset } = require('./assetPresenter');
const { audit, findViewableAsset, formerHolderAssignments, populated } = require('./asset.service');
const { logAudit } = require('./audit.service');

const PUSH = (entry) => ({ $push: { statusHistory: { $each: [entry], $slice: -LIMITS.STATUS_HISTORY } } });
const toDate = (value) => (value ? new Date(parseDateOnly(value)) : null);
const todayUtc = () => parseDateOnly(dateOnlyString(Date.now()));
const isDuplicate = (error) => error && error.code === 11000;

/**
 * Assignment integrity — the rules this file keeps:
 *
 *  1. AssetAssignment rows are the SOURCE OF TRUTH for who holds what, and are immutable history (only closed, never
 *     edited or deleted). Asset.assignedUser/assignedTeam/currentAssignment are a denormalised copy for fast reads.
 *  2. Double assignment is impossible at the database level (partial unique indexes on ACTIVE assignments); the
 *     application checks only turn those races into clean 409s.
 *  3. Multi-step operations never use transactions (a standalone MongoDB has none). Instead each step is a CONDITIONAL
 *     atomic update, ordered so that a failure between steps leaves a state `repairAsset` can fix from the assignments:
 *       assign:   write the assignment first → then claim the asset (or void the assignment if the claim loses)
 *       return:   close the assignment first → then release the asset
 *       transfer: close the old row → open the new row → then re-point the asset (restoring the old holder if opening fails)
 *     A failed history write can therefore never leave an asset marked as held by nobody-in-particular.
 */

async function loadTarget(actor, { assigneeType, userId, teamId }) {
  if (assigneeType === ASSIGNEE_TYPE.TEAM) {
    if (!mongoose.isValidObjectId(teamId)) throw new AppError('Team not found', 404, 'NOT_FOUND');
    const team = await Team.findOne({ _id: teamId, organization: actor.organization }).select('name members lead').lean();
    if (!team) throw new AppError('Team not found', 404, 'NOT_FOUND');
    return { type: ASSIGNEE_TYPE.TEAM, team: team._id, user: null, name: team.name };
  }
  if (!mongoose.isValidObjectId(userId)) throw new AppError('Person not found', 404, 'NOT_FOUND');
  // Another organization's user is indistinguishable from a nonexistent one.
  const user = await User.findOne({ _id: userId, organization: actor.organization }).select('firstName lastName isActive orgBlocked').lean();
  if (!user) throw new AppError('Person not found', 404, 'NOT_FOUND');
  if (!user.isActive || user.orgBlocked) throw new AppError('Assets can only be assigned to active members of the organization', 400, 'ASSIGNEE_INACTIVE');
  return { type: ASSIGNEE_TYPE.USER, user: user._id, team: null, name: fullName(user) };
}

const holderFields = (target) => ({
  assignedUser: target.type === ASSIGNEE_TYPE.USER ? target.user : null,
  assignedTeam: target.type === ASSIGNEE_TYPE.TEAM ? target.team : null,
});

function newAssignmentDoc({ actor, asset, target, body, exclusive, previous = null, notes }) {
  return {
    organization: actor.organization,
    asset: asset._id,
    exclusive,
    assigneeType: target.type,
    user: target.user,
    team: target.team,
    assignedBy: actor._id,
    assignedAt: new Date(),
    expectedReturnAt: toDate(body.expectedReturnDate),
    notes: notes ?? body.notes ?? '',
    conditionAtAssignment: body.condition || asset.condition || ASSET_CONDITION.GOOD,
    previousAssignment: previous,
  };
}

async function voidAssignment(id) {
  await AssetAssignment.updateOne({ _id: id, status: ASSIGNMENT_STATUS.ACTIVE }, { $set: { status: ASSIGNMENT_STATUS.VOID, closedAt: new Date() } }).catch(() => {});
}

function assertAssignable(asset) {
  if (asset.deletedAt) throw new AppError('Asset not found', 404, 'NOT_FOUND');
  if ([ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED, ASSET_STATUS.LOST].includes(asset.status)) {
    throw new AppError(`A ${asset.status.toLowerCase()} asset cannot be assigned`, 409, 'ASSET_NOT_ASSIGNABLE');
  }
  if (asset.status === ASSET_STATUS.UNDER_MAINTENANCE) throw new AppError('This asset is under maintenance', 409, 'ASSET_NOT_ASSIGNABLE');
}

// ---- assign -------------------------------------------------------------------------------------

async function assignAsset({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  assertAssignable(asset);
  if (asset.kind === ASSET_KIND.HARDWARE && asset.status === ASSET_STATUS.ASSIGNED) {
    throw new AppError('This asset is already assigned. Transfer it instead.', 409, 'ALREADY_ASSIGNED');
  }
  const target = await loadTarget(actor, body);
  if (!canAssignTo(ctx, asset, { user: target.user, team: target.team })) {
    throw new AppError('You can only assign equipment to people and teams you manage', 403, 'FORBIDDEN');
  }

  return asset.kind === ASSET_KIND.SOFTWARE ? assignSeat({ actor, asset, target, body, req }) : assignHardware({ actor, asset, target, body, req });
}

async function assignHardware({ actor, asset, target, body, req }) {
  let assignment;
  try {
    assignment = await AssetAssignment.create(newAssignmentDoc({ actor, asset, target, body, exclusive: true }));
  } catch (error) {
    if (isDuplicate(error)) throw new AppError('This asset is already assigned', 409, 'ALREADY_ASSIGNED'); // the unique index won a race
    throw error;
  }

  let claimed;
  try {
    claimed = await Asset.findOneAndUpdate(
      { _id: asset._id, organization: actor.organization, deletedAt: null, status: { $in: [ASSET_STATUS.AVAILABLE, ASSET_STATUS.RESERVED] }, currentAssignment: null },
      {
        $set: { status: ASSET_STATUS.ASSIGNED, ...holderFields(target), currentAssignment: assignment._id, condition: assignment.conditionAtAssignment, updatedBy: actor._id },
        ...PUSH({ from: asset.status, to: ASSET_STATUS.ASSIGNED, action: 'assign', by: actor._id, at: new Date(), note: target.name }),
      },
      { new: true },
    );
  } catch (error) {
    await voidAssignment(assignment._id);
    throw error;
  }
  if (!claimed) {
    await voidAssignment(assignment._id); // lost the race (or the asset changed): the attempt leaves no trace as a holder
    throw new AppError('This asset is no longer available to assign', 409, 'ASSET_NOT_AVAILABLE');
  }

  await audit(actor, req, AUDIT_EVENTS.ASSET_ASSIGNED, claimed, { to: target.name, toType: target.type, assignment: idOf(assignment._id) });
  await events.assigned({ asset: claimed, actor, assignment });
  return { assignment: await presentAssignment(assignment), asset: presentAsset(await populated(claimed._id), await loadAssetContext(actor)) };
}

async function assignSeat({ actor, asset, target, body, req }) {
  if (target.type !== ASSIGNEE_TYPE.USER) throw new AppError('Software seats are assigned to people', 400, 'SEAT_NEEDS_PERSON');
  if (asset.license?.expiryDate && asset.license.expiryDate.getTime() < todayUtc()) {
    throw new AppError('This license has expired', 409, 'LICENSE_EXPIRED');
  }

  let assignment;
  try {
    assignment = await AssetAssignment.create(newAssignmentDoc({ actor, asset, target, body, exclusive: false }));
  } catch (error) {
    if (isDuplicate(error)) throw new AppError('This person already has a seat', 409, 'ALREADY_ASSIGNED');
    throw error;
  }

  let claimed;
  try {
    // The seat counter only moves when a seat is actually free — two requests for the last seat cannot both win.
    claimed = await Asset.findOneAndUpdate(
      { _id: asset._id, organization: actor.organization, deletedAt: null, kind: ASSET_KIND.SOFTWARE, status: ASSET_STATUS.AVAILABLE, $expr: { $lt: ['$license.allocatedSeats', '$license.seats'] } },
      { $inc: { 'license.allocatedSeats': 1 }, $set: { updatedBy: actor._id } },
      { new: true },
    );
  } catch (error) {
    await voidAssignment(assignment._id);
    throw error;
  }
  if (!claimed) {
    await voidAssignment(assignment._id);
    throw new AppError('No seats are available for this license', 409, 'NO_SEATS_AVAILABLE');
  }

  await audit(actor, req, AUDIT_EVENTS.ASSET_ASSIGNED, claimed, { to: target.name, seat: true, assignment: idOf(assignment._id) });
  await events.assigned({ asset: claimed, actor, assignment });
  return { assignment: await presentAssignment(assignment), asset: presentAsset(await populated(claimed._id), await loadAssetContext(actor)) };
}

// ---- transfer -------------------------------------------------------------------------------------

async function transferAsset({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  const software = asset.kind === ASSET_KIND.SOFTWARE;

  const current = software
    ? await AssetAssignment.findOne({ asset: asset._id, user: body.fromUserId, status: ASSIGNMENT_STATUS.ACTIVE })
    : asset.currentAssignment && (await AssetAssignment.findOne({ _id: asset.currentAssignment, status: ASSIGNMENT_STATUS.ACTIVE }));
  if (!current || (!software && asset.status !== ASSET_STATUS.ASSIGNED)) {
    throw new AppError(software ? 'That person does not hold a seat' : 'This asset is not currently assigned, so it cannot be transferred', 409, 'NOT_ASSIGNED');
  }
  if (software && body.assigneeType === ASSIGNEE_TYPE.TEAM) throw new AppError('Software seats are assigned to people', 400, 'SEAT_NEEDS_PERSON');

  const target = await loadTarget(actor, body);
  const sameHolder = idOf(current.user) === idOf(target.user) && idOf(current.team) === idOf(target.team) && current.assigneeType === target.type;
  if (sameHolder) throw new AppError('The asset is already held by that assignee', 400, 'SAME_HOLDER');
  if (!canTransferTo(ctx, asset, { user: current.user, team: current.team }, { user: target.user, team: target.team })) {
    throw new AppError('You can only transfer equipment between people and teams you manage', 403, 'FORBIDDEN');
  }

  // 1. Close the old holder's row (conditional: someone else may have returned/transferred it in the meantime).
  const closed = await AssetAssignment.findOneAndUpdate(
    { _id: current._id, status: ASSIGNMENT_STATUS.ACTIVE },
    { $set: { status: ASSIGNMENT_STATUS.CLOSED, closeReason: CLOSE_REASON.TRANSFERRED, closedAt: new Date(), closedBy: actor._id, returnedCondition: body.condition || asset.condition, returnNotes: body.notes || '' } },
    { new: true },
  );
  if (!closed) throw new AppError('The asset changed while you were working. Refresh and try again.', 409, 'CONFLICT');

  // 2. Open the new holder's row; if that fails, put the previous holder back so nobody is left holding nothing.
  let next;
  try {
    next = await AssetAssignment.create(newAssignmentDoc({ actor, asset, target, body, exclusive: !software, previous: current._id }));
  } catch (error) {
    await AssetAssignment.create(newAssignmentDoc({
      actor, asset, target: { type: current.assigneeType, user: current.user, team: current.team }, body: { condition: current.conditionAtAssignment },
      exclusive: !software, previous: current._id, notes: 'Restored after a transfer that could not be completed',
    })).catch(() => {});
    await repairAsset(asset._id);
    throw isDuplicate(error) ? new AppError('That assignee already holds this', 409, 'ALREADY_ASSIGNED') : error;
  }

  // 3. Re-point the asset (hardware). Seats don't move the counter: one seat leaves, one arrives.
  if (!software) {
    const moved = await Asset.findOneAndUpdate(
      { _id: asset._id, organization: actor.organization, currentAssignment: current._id },
      {
        $set: { ...holderFields(target), currentAssignment: next._id, updatedBy: actor._id },
        ...PUSH({ from: asset.status, to: asset.status, action: 'transfer', by: actor._id, at: new Date(), note: target.name }),
      },
      { new: true },
    );
    if (!moved) await repairAsset(asset._id); // the assignments are authoritative; the asset catches up
  }

  const fresh = await Asset.findById(asset._id);
  await audit(actor, req, AUDIT_EVENTS.ASSET_TRANSFERRED, fresh, { from: idOf(current.user) || idOf(current.team), to: target.name, toType: target.type, assignment: idOf(next._id) });
  await events.transferred({ asset: fresh, actor, from: current, to: target, newAssignment: next, toName: target.name });
  return { assignment: await presentAssignment(next), asset: presentAsset(await populated(asset._id), await loadAssetContext(actor)) };
}

// ---- return ---------------------------------------------------------------------------------------

async function returnAsset({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  const software = asset.kind === ASSET_KIND.SOFTWARE;

  const current = software
    ? await AssetAssignment.findOne({ asset: asset._id, user: body.userId, status: ASSIGNMENT_STATUS.ACTIVE })
    : asset.currentAssignment && (await AssetAssignment.findOne({ _id: asset.currentAssignment, status: ASSIGNMENT_STATUS.ACTIVE }));
  if (!current) throw new AppError(software ? 'That person does not hold a seat' : 'This asset is not currently assigned', 409, 'NOT_ASSIGNED');
  if (!canReturnFrom(ctx, asset, { user: current.user, team: current.team })) {
    throw new AppError('You can only return equipment held by people and teams you manage', 403, 'FORBIDDEN');
  }

  // 1. Close the assignment (history first). Conditional, so a double-click or concurrent return is a clean 409.
  const closed = await AssetAssignment.findOneAndUpdate(
    { _id: current._id, status: ASSIGNMENT_STATUS.ACTIVE },
    { $set: { status: ASSIGNMENT_STATUS.CLOSED, closeReason: CLOSE_REASON.RETURNED, closedAt: new Date(), closedBy: actor._id, returnedCondition: body.condition || asset.condition, returnNotes: body.notes || '' } },
    { new: true },
  );
  if (!closed) throw new AppError('This asset was already returned', 409, 'NOT_ASSIGNED');

  // 2. Release the asset / the seat. If this step fails the assignments say "returned" and the repair catches the asset up.
  try {
    if (software) {
      await Asset.updateOne({ _id: asset._id, 'license.allocatedSeats': { $gt: 0 } }, { $inc: { 'license.allocatedSeats': -1 }, $set: { updatedBy: actor._id } });
    } else {
      await releaseHardware(asset, closed, actor);
    }
  } catch (error) {
    await repairAsset(asset._id);
    throw error;
  }

  const fresh = await Asset.findById(asset._id);
  await audit(actor, req, AUDIT_EVENTS.ASSET_RETURNED, fresh, { assignment: idOf(current._id), condition: closed.returnedCondition });
  await events.returned({ asset: fresh, actor, assignment: closed, condition: closed.returnedCondition });
  return { assignment: await presentAssignment(closed), asset: presentAsset(await populated(asset._id), await loadAssetContext(actor)) };
}

async function releaseHardware(asset, closedAssignment, actor) {
  const base = { assignedUser: null, assignedTeam: null, currentAssignment: null, updatedBy: actor?._id ?? null };
  const condition = closedAssignment.returnedCondition ? { condition: closedAssignment.returnedCondition } : {};
  const entry = { from: asset.status, to: ASSET_STATUS.AVAILABLE, action: 'return', by: actor?._id ?? null, at: new Date() };

  const released = await Asset.findOneAndUpdate(
    { _id: asset._id, currentAssignment: closedAssignment._id, status: ASSET_STATUS.ASSIGNED },
    { $set: { ...base, ...condition, status: ASSET_STATUS.AVAILABLE }, ...PUSH(entry) },
    { new: true },
  );
  if (released) return released;
  // Returned while being repaired: it stays under maintenance but is no longer held, and goes back to the pool afterwards.
  return Asset.findOneAndUpdate(
    { _id: asset._id, currentAssignment: closedAssignment._id, status: ASSET_STATUS.UNDER_MAINTENANCE },
    { $set: { ...base, ...condition, statusBeforeMaintenance: ASSET_STATUS.AVAILABLE } },
    { new: true },
  );
}

async function requestReturn({ actor, id, body, req }) {
  const { asset, ctx } = await findViewableAsset(id, actor, { populate: false });
  const current = asset.kind === ASSET_KIND.SOFTWARE
    ? await AssetAssignment.findOne({ asset: asset._id, user: body.userId, status: ASSIGNMENT_STATUS.ACTIVE })
    : asset.currentAssignment && (await AssetAssignment.findOne({ _id: asset.currentAssignment, status: ASSIGNMENT_STATUS.ACTIVE }));
  if (!current) throw new AppError('This asset is not currently assigned', 409, 'NOT_ASSIGNED');
  if (!canReturnFrom(ctx, asset, { user: current.user, team: current.team })) throw new AppError('You can only ask for equipment back from people and teams you manage', 403, 'FORBIDDEN');

  await AssetAssignment.updateOne({ _id: current._id, status: ASSIGNMENT_STATUS.ACTIVE }, { $set: { returnRequestedAt: new Date() } });
  await audit(actor, req, AUDIT_EVENTS.ASSET_RETURN_REQUESTED, asset, { assignment: idOf(current._id) });
  await events.returnRequested({ asset, actor, assignment: current, note: body.note });
  return { success: true };
}

// ---- integrity repair ----------------------------------------------------------------------------

/**
 * Brings ONE asset's denormalised holder fields back in line with its assignments (the source of truth).
 * Safe to call at any time and idempotent. Used right after a failed multi-step operation and by the hourly job.
 */
async function repairAsset(assetId, { actor = null, minAgeMs = 0 } = {}) {
  const asset = await Asset.findById(assetId);
  if (!asset) return null;

  if (asset.kind === ASSET_KIND.SOFTWARE) {
    const used = await AssetAssignment.countDocuments({ asset: asset._id, status: ASSIGNMENT_STATUS.ACTIVE });
    if (asset.license && asset.license.allocatedSeats !== used) {
      await Asset.updateOne({ _id: asset._id }, { $set: { 'license.allocatedSeats': used } });
      await logAudit({ action: AUDIT_EVENTS.ASSET_INTEGRITY_REPAIRED, entityId: idOf(asset._id), entityType: 'asset', metadata: { seats: { was: asset.license.allocatedSeats, now: used } }, organizationId: asset.organization, userId: actor?._id ?? null });
      return { repaired: 'seats' };
    }
    return null;
  }

  const active = await AssetAssignment.findOne({ asset: asset._id, status: ASSIGNMENT_STATUS.ACTIVE, exclusive: true }).sort({ assignedAt: -1 });
  const holderStatus = [ASSET_STATUS.ASSIGNED, ASSET_STATUS.UNDER_MAINTENANCE];

  if (active) {
    if (Date.now() - active.createdAt.getTime() < minAgeMs) return null; // still being written by a live request
    if (idOf(asset.currentAssignment) !== idOf(active._id) || (asset.status === ASSET_STATUS.AVAILABLE || asset.status === ASSET_STATUS.RESERVED)) {
      // A live assignment exists but the asset doesn't reflect it: make the asset follow the assignment.
      const set = { assignedUser: active.user, assignedTeam: active.team, currentAssignment: active._id };
      if (!holderStatus.includes(asset.status)) set.status = ASSET_STATUS.ASSIGNED;
      await Asset.updateOne({ _id: asset._id }, { $set: set, ...PUSH({ from: asset.status, to: set.status || asset.status, action: 'reconciled', at: new Date(), note: 'Matched to the active assignment' }) });
      await logAudit({ action: AUDIT_EVENTS.ASSET_INTEGRITY_REPAIRED, entityId: idOf(asset._id), entityType: 'asset', metadata: { reason: 'asset followed active assignment' }, organizationId: asset.organization, userId: actor?._id ?? null });
      return { repaired: 'followed-assignment' };
    }
    return null;
  }

  // No live assignment: an asset still claiming a holder is wrong.
  if (asset.currentAssignment || asset.assignedUser || asset.assignedTeam || asset.status === ASSET_STATUS.ASSIGNED) {
    const set = { assignedUser: null, assignedTeam: null, currentAssignment: null };
    if (asset.status === ASSET_STATUS.ASSIGNED) set.status = ASSET_STATUS.AVAILABLE;
    if (asset.status === ASSET_STATUS.UNDER_MAINTENANCE) set.statusBeforeMaintenance = ASSET_STATUS.AVAILABLE;
    await Asset.updateOne({ _id: asset._id }, { $set: set, ...PUSH({ from: asset.status, to: set.status || asset.status, action: 'reconciled', at: new Date(), note: 'No active assignment' }) });
    await logAudit({ action: AUDIT_EVENTS.ASSET_INTEGRITY_REPAIRED, entityId: idOf(asset._id), entityType: 'asset', metadata: { reason: 'released: no active assignment' }, organizationId: asset.organization, userId: actor?._id ?? null });
    return { repaired: 'released' };
  }
  return null;
}

/**
 * Sweeps for assets whose holder fields disagree with their assignments, and for assignment attempts that crashed
 * before claiming the asset. `minAgeMs` leaves rows alone while a live request may still be mid-flight.
 */
async function reconcileAssignments({ minAgeMs = 2 * 60 * 1000, limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - minAgeMs);
  let repaired = 0;

  // (a) assets that claim a holder: verify against the assignments
  const claiming = await Asset.find({ kind: ASSET_KIND.HARDWARE, $or: [{ currentAssignment: { $ne: null } }, { status: ASSET_STATUS.ASSIGNED }] }).select('_id').limit(limit).lean();
  // (b) live assignments created long enough ago that the asset should reflect them
  const live = await AssetAssignment.find({ status: ASSIGNMENT_STATUS.ACTIVE, exclusive: true, createdAt: { $lt: cutoff } }).select('asset').limit(limit).lean();
  // (c) software assets: seat counters
  const software = await Asset.find({ kind: ASSET_KIND.SOFTWARE, license: { $ne: null } }).select('_id').limit(limit).lean();

  const ids = new Set([...claiming, ...live.map((entry) => ({ _id: entry.asset })), ...software].map((entry) => idOf(entry._id)));
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (await repairAsset(id, { minAgeMs })) repaired += 1;
  }
  return { checked: ids.size, repaired };
}

// ---- reading --------------------------------------------------------------------------------------

async function presentAssignment(assignment) {
  const doc = assignment.populate ? await assignment.populate([
    { path: 'user', select: 'firstName lastName email isActive orgBlocked organization' },
    { path: 'team', select: 'name' },
    { path: 'assignedBy', select: 'firstName lastName' },
    { path: 'closedBy', select: 'firstName lastName' },
  ]) : assignment;
  const row = doc.toObject();
  const asset = row.asset && row.asset.name ? { id: idOf(row.asset), name: row.asset.name, assetId: row.asset.assetId } : { id: idOf(row.asset) };
  return {
    id: idOf(row._id),
    asset,
    assigneeType: row.assigneeType,
    user: row.user ? { id: idOf(row.user), name: fullName(row.user), email: row.user.email, former: isFormerMember(row.user, row.organization) } : null,
    team: row.team ? { id: idOf(row.team), name: row.team.name } : null,
    assignedBy: row.assignedBy ? { id: idOf(row.assignedBy), name: fullName(row.assignedBy) } : null,
    assignedAt: row.assignedAt,
    expectedReturnDate: row.expectedReturnAt ? dateOnlyString(row.expectedReturnAt.getTime()) : null,
    notes: row.notes,
    conditionAtAssignment: row.conditionAtAssignment,
    status: row.status,
    closeReason: row.closeReason,
    closedAt: row.closedAt,
    closedBy: row.closedBy ? { id: idOf(row.closedBy), name: fullName(row.closedBy) } : null,
    returnedCondition: row.returnedCondition,
    returnNotes: row.returnNotes,
    returnRequestedAt: row.returnRequestedAt,
    overdue: row.status === ASSIGNMENT_STATUS.ACTIVE && Boolean(row.expectedReturnAt) && row.expectedReturnAt.getTime() < todayUtc(),
  };
}

const ASSIGNMENT_POPULATE = [
  { path: 'user', select: 'firstName lastName email isActive orgBlocked organization' },
  { path: 'team', select: 'name' },
  { path: 'assignedBy', select: 'firstName lastName' },
  { path: 'closedBy', select: 'firstName lastName' },
];

/** Full holder history of one asset, newest first. Voided attempts are hidden; nothing real is ever removed. */
async function listAssetHistory({ actor, id, page = 1, limit = 20 }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  if (!can(actor, PERMISSIONS.VIEW_ASSETS)) throw new AppError('You do not have permission to view the assignment history', 403, 'FORBIDDEN');
  const filter = { organization: actor.organization, asset: asset._id, status: { $ne: ASSIGNMENT_STATUS.VOID } };
  const [rows, total] = await Promise.all([
    AssetAssignment.find(filter).sort({ assignedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate(ASSIGNMENT_POPULATE),
    AssetAssignment.countDocuments(filter),
  ]);
  return { assignments: await Promise.all(rows.map(presentAssignment)), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

/** Organization-wide assignments feed, scoped like assets: org-wide roles see all, managers the people/teams they lead. */
async function listAssignments({ actor, query }) {
  const ctx = await loadAssetContext(actor);
  const filter = { organization: actor.organization, status: query.status ? query.status : { $in: [ASSIGNMENT_STATUS.ACTIVE, ASSIGNMENT_STATUS.CLOSED] } };
  if (!isOrgWide(actor)) {
    filter.$or = [{ user: { $in: [...ctx.ledMemberIds] } }, { team: { $in: [...ctx.ledTeamIds] } }];
  }
  if (query.userId) filter.user = query.userId;
  if (query.teamId) filter.team = query.teamId;
  if (query.assetId) filter.asset = query.assetId;

  const [rows, total] = await Promise.all([
    AssetAssignment.find(filter).sort({ assignedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit)
      .populate(ASSIGNMENT_POPULATE).populate({ path: 'asset', select: 'name assetId kind' }),
    AssetAssignment.countDocuments(filter),
  ]);
  return { assignments: await Promise.all(rows.map(presentAssignment)), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
}

/** Assets the viewer holds right now (directly, through a team, or as a license seat). */
async function listMyAssets({ actor }) {
  const ctx = await loadAssetContext(actor);
  const teamIds = [...ctx.teamIds];
  const assignments = await AssetAssignment.find({
    organization: actor.organization, status: ASSIGNMENT_STATUS.ACTIVE,
    $or: [{ user: actor._id }, ...(teamIds.length ? [{ team: { $in: teamIds } }] : [])],
  }).sort({ assignedAt: -1 }).lean();
  if (!assignments.length) return { assets: [] };

  let query = Asset.find({ _id: { $in: assignments.map((a) => a.asset) }, organization: actor.organization, deletedAt: null });
  ASSET_POPULATE.forEach((entry) => { query = query.populate(entry); });
  const assets = new Map((await query).map((asset) => [idOf(asset._id), asset]));

  return {
    assets: assignments.filter((a) => assets.has(idOf(a.asset))).map((a) => ({
      ...presentAsset(assets.get(idOf(a.asset)), ctx),
      assignment: {
        id: idOf(a._id), assignedAt: a.assignedAt, expectedReturnDate: a.expectedReturnAt ? dateOnlyString(a.expectedReturnAt.getTime()) : null,
        conditionAtAssignment: a.conditionAtAssignment, returnRequestedAt: a.returnRequestedAt, viaTeam: a.assigneeType === ASSIGNEE_TYPE.TEAM,
        overdue: Boolean(a.expectedReturnAt) && a.expectedReturnAt.getTime() < todayUtc(),
      },
    })),
  };
}

/**
 * Offboarding: assets still held by people who are no longer active members (removed, deactivated or blocked).
 * Their assignment history is untouched; admins and HR use this list to get the equipment back.
 */
async function listOffboarding({ actor }) {
  if (!isOrgWide(actor)) throw new AppError('You do not have permission to view this', 403, 'FORBIDDEN');
  const former = await formerHolderAssignments(actor.organization);
  if (!former.length) return { people: [], totals: { people: 0, assignments: 0 } };

  const [assets, users] = await Promise.all([
    Asset.find({ _id: { $in: former.map((entry) => entry.asset) }, organization: actor.organization }).select('name assetId kind status location').lean(),
    User.find({ _id: { $in: [...new Set(former.map((entry) => idOf(entry.user)))] } }).select('firstName lastName email isActive orgBlocked organization').lean(),
  ]);
  const assetById = new Map(assets.map((asset) => [idOf(asset._id), asset]));
  const userById = new Map(users.map((user) => [idOf(user._id), user]));

  const people = new Map();
  former.forEach((entry) => {
    const user = userById.get(idOf(entry.user));
    const asset = assetById.get(idOf(entry.asset));
    if (!user || !asset) return;
    const key = idOf(user._id);
    if (!people.has(key)) {
      const status = idOf(user.organization) !== idOf(actor.organization) ? 'removed' : user.orgBlocked ? 'blocked' : 'deactivated';
      people.set(key, { user: { id: key, name: fullName(user), email: user.email, status }, assets: [] });
    }
    people.get(key).assets.push({ assignmentId: idOf(entry._id), assignedAt: entry.assignedAt, asset: { id: idOf(asset._id), name: asset.name, assetId: asset.assetId, kind: asset.kind, status: asset.status, location: asset.location } });
  });
  const list = [...people.values()].sort((a, b) => a.user.name.localeCompare(b.user.name));
  return { people: list, totals: { people: list.length, assignments: former.length } };
}

/** Called when someone is blocked or removed: if they still hold assets, the people running offboarding are told. */
async function notifyFormerMemberHoldings({ organization, person, actor }) {
  const count = await AssetAssignment.countDocuments({ organization, user: person._id, status: ASSIGNMENT_STATUS.ACTIVE });
  if (count > 0) await events.formerMemberHoldsAssets({ organization, person, count, actor });
  return count;
}

module.exports = {
  notifyFormerMemberHoldings,
  assignAsset, listAssetHistory, listAssignments, listMyAssets, listOffboarding, presentAssignment, reconcileAssignments, repairAsset,
  requestReturn, returnAsset, transferAsset,
};
