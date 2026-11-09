const AppError = require('../../utils/app-error');
const { PERMISSIONS } = require('../../constants/permissions');
const { ASSIGNMENT_STATUS, MAINTENANCE_STATUS } = require('../../constants/asset.constants');
const { ANALYTICS_LIMITS, SCOPE_KIND } = require('../../constants/analytics.constants');
const AssetAssignment = require('../../models/AssetAssignment');
const AssetMaintenance = require('../../models/AssetMaintenance');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { getSummary } = require('../assetReports.service');
const { percent, requireKind, run, table } = require('./common');

/**
 * Asset analytics sit on top of the existing asset summary, which is already scoped by role (managers see their
 * teams' assets, money only with VIEW_ASSET_REPORTS). Nothing here widens that: the extra series are limited the
 * same way.
 */
async function computeAssets(scope, range) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM]);
  if (!scope.permissions.includes(PERMISSIONS.VIEW_ASSETS)) throw new AppError('You do not have permission to view asset analytics', 403, 'FORBIDDEN');

  const summary = await getSummary({ actor: scope.actor });
  const withMoney = scope.permissions.includes(PERMISSIONS.VIEW_ASSET_REPORTS);
  const t = summary.totals;
  const inUse = t.total - t.retired - t.disposed - t.lost; // assets that can still be used

  const assignmentScope = scope.kind === SCOPE_KIND.TEAM ? { $or: [{ user: { $in: scope.personIds } }, { team: { $in: scope.ledTeamIds } }] } : {};
  const [assignments, spend, completedMaintenance] = await Promise.all([
    run(AssetAssignment, [
      { $match: { organization: scope.organization, status: { $in: [ASSIGNMENT_STATUS.ACTIVE, ASSIGNMENT_STATUS.CLOSED] }, assignedAt: { $gte: range.start, $lt: range.end }, ...assignmentScope } },
      { $group: { _id: bucketExpr('$assignedAt', range), assigned: { $sum: 1 } } },
    ]),
    withMoney ? run(AssetMaintenance, [
      { $match: { organization: scope.organization, status: MAINTENANCE_STATUS.COMPLETED, completedAt: { $gte: range.start, $lt: range.end }, cost: { $ne: null } } },
      { $group: { _id: '$currency', total: { $sum: '$cost' }, jobs: { $sum: 1 } } }, { $sort: { _id: 1 } },
    ]) : [],
    withMoney ? run(AssetMaintenance, [
      { $match: { organization: scope.organization, status: MAINTENANCE_STATUS.COMPLETED, completedAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: bucketExpr('$completedAt', range), jobs: { $sum: 1 } } },
    ]) : [],
  ]);

  return {
    kpis: {
      total: t.total, available: t.available, assigned: t.assigned, underMaintenance: t.underMaintenance, reserved: t.reserved, retired: t.retired, lost: t.lost,
      utilization: percent(t.assigned, inUse), expiredWarranties: t.expiredWarranties, overdueMaintenance: t.overdueMaintenance, openMaintenanceRequests: t.openMaintenanceRequests,
      seatsPurchased: summary.licenseSeats.purchased, seatsAllocated: summary.licenseSeats.allocated, seatUtilization: percent(summary.licenseSeats.allocated, summary.licenseSeats.purchased),
    },
    series: { assignments: denseSeries(assignments, range, ['assigned']), ...(withMoney ? { maintenanceJobs: denseSeries(completedMaintenance, range, ['jobs']) } : {}) },
    breakdowns: {
      byStatus: summary.byStatus.map((row) => ({ key: row.status, count: row.count })),
      byCategory: summary.byCategory.slice(0, ANALYTICS_LIMITS.TOP_N),
      byTeam: summary.byTeam.slice(0, ANALYTICS_LIMITS.TOP_N),
      expiringWarranties: summary.expiringWarranties, expiringLicenses: summary.expiringLicenses,
      // One total per currency. Different currencies are never added together.
      purchaseValue: summary.purchaseValue ? summary.purchaseValue.byCurrency : null,
      maintenanceSpend: withMoney ? spend.map((row) => ({ currency: row._id, total: row.total, jobs: row.jobs })) : null,
    },
    table: table([{ key: 'category', label: 'Category' }, { key: 'count', label: 'Assets', type: 'number' }], summary.byCategory.map((row) => ({ category: row.name, count: row.count }))),
    notes: [
      'Utilization is assigned assets divided by assets still in use (not retired, disposed or lost).',
      ...(withMoney ? ['Maintenance spend counts completed jobs in the selected period and is shown per currency.'] : []),
    ],
  };
}

module.exports = { computeAssets };
