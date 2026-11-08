const { PERMISSIONS } = require('../constants/permissions');
const { ASSET_KIND, ASSET_STATUS } = require('../constants/asset.constants');
const { can, canReportIssue } = require('../utils/assetAccess');
const { dateOnlyString } = require('../utils/timezone');

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const fullName = (user) => (user && user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : '');
const day = (date) => (date ? dateOnlyString(new Date(date).getTime()) : null);

const ASSET_POPULATE = [
  { path: 'category', select: 'name' },
  { path: 'purchase.vendor', select: 'name' },
  { path: 'team', select: 'name' },
  { path: 'assignedTeam', select: 'name' },
  { path: 'assignedUser', select: 'firstName lastName email isActive orgBlocked organization' },
];

const isFormerMember = (user, organization) =>
  Boolean(user) && (user.isActive === false || user.orgBlocked === true || idOf(user.organization) !== idOf(organization));

/**
 * The API shape of an asset. Money and dates are plain values (dates as 'YYYY-MM-DD', never shifted by a timezone).
 * `permissions` tells the UI what to offer; every action is re-checked on the server regardless.
 * License secrets are never present: only managers of licenses see the key REFERENCE, everyone else a boolean.
 */
function presentAsset(asset, ctx) {
  const doc = asset.toObject ? asset.toObject() : asset;
  const viewer = ctx.user;
  const holderUser = doc.assignedUser && doc.assignedUser.firstName ? doc.assignedUser : null;
  const held = ctx.heldAssetIds.has(idOf(doc._id));
  const idle = [ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED].includes(doc.status) || Boolean(doc.deletedAt);
  const software = doc.kind === ASSET_KIND.SOFTWARE;

  const license = doc.license
    ? {
        licenseType: doc.license.licenseType,
        seats: doc.license.seats,
        allocatedSeats: doc.license.allocatedSeats,
        availableSeats: Math.max(0, doc.license.seats - doc.license.allocatedSeats),
        startDate: day(doc.license.startDate),
        expiryDate: day(doc.license.expiryDate),
        renewalDate: day(doc.license.renewalDate),
        autoRenew: doc.license.autoRenew,
        cost: doc.license.cost,
        currency: doc.license.currency,
        hasKeyReference: Boolean(doc.license.keyReference),
        ...(can(viewer, PERMISSIONS.MANAGE_ASSET_LICENSES) ? { keyReference: doc.license.keyReference } : {}),
      }
    : null;

  return {
    id: idOf(doc._id),
    assetId: doc.assetId,
    assetTag: doc.assetTag || '',
    name: doc.name,
    kind: doc.kind,
    category: doc.category ? { id: idOf(doc.category), name: doc.category.name || '' } : null,
    subcategory: doc.subcategory,
    description: doc.description,
    brand: doc.brand,
    model: doc.model,
    manufacturer: doc.manufacturer,
    serialNumber: doc.serialNumber || '',
    purchase: {
      date: day(doc.purchase?.date),
      cost: doc.purchase?.cost ?? null,
      currency: doc.purchase?.currency,
      vendor: doc.purchase?.vendor ? { id: idOf(doc.purchase.vendor), name: doc.purchase.vendor.name || '' } : null,
      invoiceReference: doc.purchase?.invoiceReference || '',
      purchaseOrderReference: doc.purchase?.purchaseOrderReference || '',
    },
    status: doc.status,
    condition: doc.condition,
    location: doc.location,
    team: doc.team ? { id: idOf(doc.team), name: doc.team.name || '' } : null,
    assignedUser: holderUser
      ? { id: idOf(holderUser), name: fullName(holderUser), email: holderUser.email, former: isFormerMember(holderUser, doc.organization) }
      : null,
    assignedTeam: doc.assignedTeam ? { id: idOf(doc.assignedTeam), name: doc.assignedTeam.name || '' } : null,
    assignedToFormerMember: isFormerMember(holderUser, doc.organization),
    currentAssignment: idOf(doc.currentAssignment),
    warranty: { startDate: day(doc.warranty?.startDate), expiryDate: day(doc.warranty?.expiryDate) },
    maintenance: { intervalDays: doc.maintenance?.intervalDays ?? null, lastDate: day(doc.maintenance?.lastDate), nextDate: day(doc.maintenance?.nextDate) },
    license,
    notes: doc.notes,
    imageDocument: idOf(doc.imageDocument),
    archived: Boolean(doc.deletedAt),
    statusHistory: (doc.statusHistory || []).slice(-20).reverse().map((entry) => ({ ...entry, by: idOf(entry.by) })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    held,
    permissions: {
      canEdit: can(viewer, PERMISSIONS.UPDATE_ASSET) && doc.status !== ASSET_STATUS.DISPOSED && !doc.deletedAt,
      canArchive: can(viewer, PERMISSIONS.DELETE_ASSET),
      canManageLicense: software && can(viewer, PERMISSIONS.MANAGE_ASSET_LICENSES),
      canAssign: can(viewer, PERMISSIONS.ASSIGN_ASSET) && !idle && doc.status !== ASSET_STATUS.LOST,
      canTransfer: can(viewer, PERMISSIONS.TRANSFER_ASSET) && !idle && doc.status !== ASSET_STATUS.LOST,
      canReturn: can(viewer, PERMISSIONS.RETURN_ASSET) && !idle,
      canManageMaintenance: can(viewer, PERMISSIONS.MANAGE_ASSET_MAINTENANCE),
      canReportIssue: canReportIssue(ctx, doc) && !idle,
      canManageStatus: can(viewer, PERMISSIONS.UPDATE_ASSET),
    },
  };
}

module.exports = { ASSET_POPULATE, day, fullName, idOf, isFormerMember, presentAsset };
