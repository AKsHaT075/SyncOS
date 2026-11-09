const AppError = require('../../utils/app-error');
const { ROLES } = require('../../constants/roles');
const { DEFAULT_TIME_ZONE } = require('../../constants/calendar.constants');
const { AUDIT_EVENTS } = require('../../constants/audit.constants');
const AuditLog = require('../../models/AuditLog');
const Organization = require('../../models/Organization');
const User = require('../../models/User');
const { bucketExpr, denseSeries, resolveRange } = require('../../utils/analyticsRange');
const { isValidTimeZone } = require('../../utils/timezone');
const { percent, run, sum } = require('./common');

/**
 * Platform analytics for SUPER_ADMIN: organization and user COUNTS only. Nothing inside a tenant is read here —
 * no projects, tasks, meetings, documents, names or activity of any employee. Login activity is the number of
 * sign-ins (and distinct accounts) per day across the platform.
 */
async function computePlatform(actor, query = {}) {
  if (actor.role !== ROLES.SUPER_ADMIN) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  const timeZone = query.timezone && isValidTimeZone(query.timezone) ? query.timezone : DEFAULT_TIME_ZONE;
  const range = resolveRange(query, timeZone);
  const window = { $gte: range.start, $lt: range.end };

  const [orgStatus, plans, orgGrowth, userTotals, userGrowth, logins, orgsNewInRange, planInactive] = await Promise.all([
    run(Organization, [{ $group: { _id: '$isActive', count: { $sum: 1 } } }]),
    run(Organization, [{ $group: { _id: '$plan', count: { $sum: 1 } } }]),
    run(Organization, [{ $match: { createdAt: window } }, { $group: { _id: bucketExpr('$createdAt', range), organizations: { $sum: 1 } } }]),
    run(User, [{ $match: { organization: { $ne: null } } }, { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $and: ['$isActive', { $ne: ['$orgBlocked', true] }] }, 1, 0] } }, blocked: { $sum: { $cond: [{ $eq: ['$orgBlocked', true] }, 1, 0] } } } }]),
    run(User, [{ $match: { organization: { $ne: null }, createdAt: window } }, { $group: { _id: bucketExpr('$createdAt', range), users: { $sum: 1 } } }]),
    run(AuditLog, [{ $match: { action: AUDIT_EVENTS.LOGIN_SUCCEEDED, createdAt: window } },
      { $group: { _id: bucketExpr('$createdAt', range), logins: { $sum: 1 }, accounts: { $addToSet: '$user' } } }, { $addFields: { accounts: { $size: '$accounts' } } }]),
    Organization.countDocuments({ createdAt: window }),
    Organization.countDocuments({ isActive: false }),
  ]);

  const orgCount = (active) => orgStatus.find((row) => row._id === active)?.count || 0;
  const totalOrgs = orgCount(true) + orgCount(false);
  const u = userTotals[0] || { total: 0, active: 0, blocked: 0 };
  return {
    scope: { type: 'platform' },
    range: { from: range.from, to: range.to, timeZone, granularity: range.granularity },
    kpis: {
      organizations: totalOrgs, activeOrganizations: orgCount(true), suspendedOrganizations: planInactive, newOrganizations: orgsNewInRange,
      users: u.total, activeUsers: u.active, blockedUsers: u.blocked, newUsers: sum(userGrowth, 'users'),
      avgUsersPerOrganization: totalOrgs ? Number((u.total / totalOrgs).toFixed(1)) : null,
      logins: sum(logins, 'logins'), suspendedShare: percent(planInactive, totalOrgs),
    },
    series: { organizationGrowth: denseSeries(orgGrowth, range, ['organizations']), userGrowth: denseSeries(userGrowth, range, ['users']), logins: denseSeries(logins, range, ['logins', 'accounts']) },
    breakdowns: { plans: plans.map((row) => ({ key: row._id, count: row.count })).sort((a, b) => b.count - a.count) },
    notes: [
      'Platform analytics contain counts only. They do not include any organization content or employee activity.',
      'Users are counted when they belong to an organization. Login activity counts successful sign-ins recorded in the audit log.',
      'Plan distribution reflects the plan assigned to each organization; billing and usage limits are not enforced or measured yet.',
    ],
  };
}

module.exports = { computePlatform };
