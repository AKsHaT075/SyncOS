const AppError = require('../utils/app-error');
const { ASSET_KIND, ASSET_STATUS, ASSIGNMENT_STATUS, LIMITS, MAINTENANCE_STATUS, MAINTENANCE_UPCOMING_DAYS } = require('../constants/asset.constants');
const { PERMISSIONS } = require('../constants/permissions');
const Asset = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');
const AssetCategory = require('../models/AssetCategory');
const AssetMaintenance = require('../models/AssetMaintenance');
const Team = require('../models/Team');
const User = require('../models/User');
const { buildAssetVisibilityFilter, can, isOrgWide } = require('../utils/assetAccess');
const { dateOnlyString, parseDateOnly } = require('../utils/timezone');
const { loadAssetContext } = require('./assetContext');
const { ASSET_POPULATE, day, fullName, idOf } = require('./assetPresenter');
const { formerHolderAssignments } = require('./asset.service');

const DAY_MS = 86400000;
const todayUtc = () => parseDateOnly(dateOnlyString(Date.now()));

/**
 * Dashboard + reports. Every number is aggregated from live data and limited to the assets the viewer may see.
 * Money is NEVER summed across currencies: values are returned per currency. Purchase values are only included for
 * people with VIEW_ASSET_REPORTS.
 */
async function getSummary({ actor, days = 60 }) {
  const ctx = await loadAssetContext(actor);
  const organization = actor.organization;
  const scope = { organization, deletedAt: null, ...buildAssetVisibilityFilter(ctx) };
  const withMoney = can(actor, PERMISSIONS.VIEW_ASSET_REPORTS);
  const today = todayUtc();
  const horizon = new Date(today + days * DAY_MS);

  const hardware = { ...scope, kind: ASSET_KIND.HARDWARE };
  const [byStatus, byCategory, byTeam, byHolder, valueByCategory, valueByCurrency, kinds, expiringWarranties, expiredWarranties, expiringLicenses, seats] = await Promise.all([
    Asset.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Asset.aggregate([{ $match: scope }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
    Asset.aggregate([{ $match: scope }, { $group: { _id: '$team', count: { $sum: 1 } } }]),
    Asset.aggregate([
      { $match: { ...hardware, assignedUser: { $ne: null } } }, { $group: { _id: '$assignedUser', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 },
    ]),
    withMoney ? Asset.aggregate([
      { $match: { ...scope, 'purchase.cost': { $ne: null } } },
      { $group: { _id: { category: '$category', currency: '$purchase.currency' }, total: { $sum: '$purchase.cost' }, count: { $sum: 1 } } },
    ]) : [],
    withMoney ? Asset.aggregate([
      { $match: { ...scope, 'purchase.cost': { $ne: null } } },
      { $group: { _id: '$purchase.currency', total: { $sum: '$purchase.cost' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } },
    ]) : [],
    Asset.aggregate([{ $match: scope }, { $group: { _id: '$kind', count: { $sum: 1 } } }]),
    Asset.find({ ...scope, 'warranty.expiryDate': { $gte: new Date(today), $lte: horizon } }).sort({ 'warranty.expiryDate': 1 }).limit(10).select('name assetId warranty status').lean(),
    Asset.countDocuments({ ...scope, 'warranty.expiryDate': { $lt: new Date(today) }, status: { $nin: [ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED] } }),
    Asset.find({ ...scope, kind: ASSET_KIND.SOFTWARE, $or: [{ 'license.expiryDate': { $gte: new Date(today), $lte: horizon } }, { 'license.renewalDate': { $gte: new Date(today), $lte: horizon } }] })
      .sort({ 'license.expiryDate': 1 }).limit(10).select('name assetId license').lean(),
    Asset.aggregate([{ $match: { ...scope, kind: ASSET_KIND.SOFTWARE, license: { $ne: null } } }, { $group: { _id: null, purchased: { $sum: '$license.seats' }, allocated: { $sum: '$license.allocatedSeats' } } }]),
  ]);

  const [categories, teams, holders] = await Promise.all([
    AssetCategory.find({ _id: { $in: byCategory.map((row) => row._id) } }).select('name').lean(),
    Team.find({ _id: { $in: byTeam.map((row) => row._id).filter(Boolean) } }).select('name').lean(),
    User.find({ _id: { $in: byHolder.map((row) => row._id) } }).select('firstName lastName').lean(),
  ]);
  const categoryName = new Map(categories.map((c) => [idOf(c._id), c.name]));
  const teamName = new Map(teams.map((t) => [idOf(t._id), t.name]));
  const holderName = new Map(holders.map((u) => [idOf(u._id), fullName(u)]));
  const statusCount = Object.fromEntries(byStatus.map((row) => [row._id, row.count]));
  const total = byStatus.reduce((sum, row) => sum + row.count, 0);

  const orgWide = isOrgWide(actor);
  const visibleAssetIds = orgWide ? null : (await Asset.find(scope).select('_id').limit(5000).lean()).map((a) => a._id);
  const maintenanceScope = { organization, ...(visibleAssetIds ? { asset: { $in: visibleAssetIds } } : {}) };
  const [upcomingMaintenance, overdueMaintenance, openRequests, recent, former] = await Promise.all([
    AssetMaintenance.find({ ...maintenanceScope, status: MAINTENANCE_STATUS.SCHEDULED, scheduledDate: { $gte: new Date(today), $lte: new Date(today + MAINTENANCE_UPCOMING_DAYS * DAY_MS) } })
      .sort({ scheduledDate: 1 }).limit(10).populate({ path: 'asset', select: 'name assetId' }).lean(),
    AssetMaintenance.countDocuments({ ...maintenanceScope, status: MAINTENANCE_STATUS.SCHEDULED, scheduledDate: { $lt: new Date(today) } }),
    can(actor, PERMISSIONS.MANAGE_ASSET_MAINTENANCE) ? AssetMaintenance.countDocuments({ organization, status: MAINTENANCE_STATUS.REQUESTED }) : 0,
    AssetAssignment.find({
      organization, status: { $in: [ASSIGNMENT_STATUS.ACTIVE, ASSIGNMENT_STATUS.CLOSED] },
      ...(orgWide ? {} : { $or: [{ user: { $in: [...ctx.ledMemberIds] } }, { team: { $in: [...ctx.ledTeamIds] } }] }),
    }).sort({ assignedAt: -1 }).limit(8).populate('user', 'firstName lastName').populate('team', 'name').populate('asset', 'name assetId').lean(),
    orgWide ? formerHolderAssignments(organization) : [],
  ]);

  const currencyTotals = valueByCurrency.map((row) => ({ currency: row._id, total: row.total, assets: row.count }));
  const valueRows = valueByCategory.map((row) => ({ category: categoryName.get(idOf(row._id.category)) || 'Uncategorised', currency: row._id.currency, total: row.total, assets: row.count }));

  return {
    totals: {
      total,
      available: statusCount[ASSET_STATUS.AVAILABLE] || 0,
      assigned: statusCount[ASSET_STATUS.ASSIGNED] || 0,
      underMaintenance: statusCount[ASSET_STATUS.UNDER_MAINTENANCE] || 0,
      reserved: statusCount[ASSET_STATUS.RESERVED] || 0,
      retired: statusCount[ASSET_STATUS.RETIRED] || 0,
      disposed: statusCount[ASSET_STATUS.DISPOSED] || 0,
      lost: statusCount[ASSET_STATUS.LOST] || 0,
      hardware: kinds.find((row) => row._id === ASSET_KIND.HARDWARE)?.count || 0,
      software: kinds.find((row) => row._id === ASSET_KIND.SOFTWARE)?.count || 0,
      expiredWarranties,
      overdueMaintenance,
      openMaintenanceRequests: openRequests,
      heldByFormerMembers: former.length,
    },
    // One total PER CURRENCY — different currencies are never added together. null = not permitted to see money.
    purchaseValue: withMoney ? { byCurrency: currencyTotals } : null,
    byStatus: Object.values(ASSET_STATUS).map((status) => ({ status, count: statusCount[status] || 0 })),
    byCategory: byCategory.map((row) => ({ id: idOf(row._id), name: categoryName.get(idOf(row._id)) || 'Uncategorised', count: row.count })).sort((a, b) => b.count - a.count),
    byTeam: byTeam.map((row) => ({ id: idOf(row._id), name: row._id ? teamName.get(idOf(row._id)) || 'Unknown team' : 'No team', count: row.count })).sort((a, b) => b.count - a.count),
    assignmentDistribution: [
      ...byHolder.map((row) => ({ id: idOf(row._id), name: holderName.get(idOf(row._id)) || 'Former member', count: row.count })),
    ],
    valueByCategory: withMoney ? valueRows : null,
    licenseSeats: { purchased: seats[0]?.purchased || 0, allocated: seats[0]?.allocated || 0 },
    expiringWarranties: expiringWarranties.map((asset) => ({
      id: idOf(asset._id), name: asset.name, assetId: asset.assetId, expiryDate: day(asset.warranty.expiryDate),
      daysLeft: Math.round((asset.warranty.expiryDate.getTime() - today) / DAY_MS),
    })),
    expiringLicenses: expiringLicenses.map((asset) => ({
      id: idOf(asset._id), name: asset.name, assetId: asset.assetId, expiryDate: day(asset.license.expiryDate), renewalDate: day(asset.license.renewalDate),
      seats: asset.license.seats, allocatedSeats: asset.license.allocatedSeats,
    })),
    upcomingMaintenance: upcomingMaintenance.map((record) => ({
      id: idOf(record._id), asset: record.asset ? { id: idOf(record.asset), name: record.asset.name, assetId: record.asset.assetId } : null,
      type: record.type, issue: record.issue, scheduledDate: day(record.scheduledDate),
    })),
    recentAssignments: recent.map((row) => ({
      id: idOf(row._id), asset: row.asset ? { id: idOf(row.asset), name: row.asset.name, assetId: row.asset.assetId } : null,
      assignee: row.user ? fullName(row.user) : row.team?.name || '', assignedAt: row.assignedAt, status: row.status,
    })),
    window: { days },
  };
}

// ---- CSV export ---------------------------------------------------------------------------------------------

/** Spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) would be executed by Excel — neutralise it. */
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function exportCsv({ actor }) {
  if (!can(actor, PERMISSIONS.VIEW_ASSET_REPORTS)) throw new AppError('You do not have permission to export assets', 403, 'FORBIDDEN');
  const ctx = await loadAssetContext(actor);
  let query = Asset.find({ organization: actor.organization, deletedAt: null, ...buildAssetVisibilityFilter(ctx) }).sort({ assetId: 1 }).limit(LIMITS.EXPORT_MAX);
  ASSET_POPULATE.forEach((entry) => { query = query.populate(entry); });
  const assets = await query.lean();

  const header = ['Asset ID', 'Tag', 'Name', 'Type', 'Category', 'Status', 'Condition', 'Location', 'Team', 'Assigned to', 'Serial number', 'Brand', 'Model',
    'Purchase date', 'Cost', 'Currency', 'Vendor', 'Warranty expiry', 'License seats', 'Seats used', 'License expiry'];
  const rows = assets.map((asset) => [
    asset.assetId, asset.assetTag, asset.name, asset.kind, asset.category?.name, asset.status, asset.condition, asset.location, asset.team?.name,
    asset.assignedUser ? fullName(asset.assignedUser) : asset.assignedTeam?.name, asset.serialNumber, asset.brand, asset.model,
    day(asset.purchase?.date), asset.purchase?.cost, asset.purchase?.currency, asset.purchase?.vendor?.name, day(asset.warranty?.expiryDate),
    asset.license?.seats, asset.license?.allocatedSeats, day(asset.license?.expiryDate), // license KEY references are never exported
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

module.exports = { csvCell, exportCsv, getSummary };
