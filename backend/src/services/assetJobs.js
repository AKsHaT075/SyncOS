const { ASSET_KIND, ASSET_STATUS, LICENSE_ALERT_DAYS, MAINTENANCE_STATUS, WARRANTY_ALERT_DAYS } = require('../constants/asset.constants');
const Asset = require('../models/Asset');
const AssetMaintenance = require('../models/AssetMaintenance');
const { dateOnlyString, parseDateOnly } = require('../utils/timezone');
const { reconcileAssignments } = require('./assetAssignment.service');
const events = require('./assetEvents');

const DAY_MS = 86400000;
const todayUtc = () => parseDateOnly(dateOnlyString(Date.now()));
const daysUntil = (date, today) => Math.round((date.getTime() - today) / DAY_MS);
const LIVE = { deletedAt: null, status: { $nin: [ASSET_STATUS.RETIRED, ASSET_STATUS.DISPOSED] } };

/**
 * The smallest alert threshold that covers `daysLeft` (e.g. 5 days left → the 7-day alert). Each threshold fires once
 * per date, so an asset moves 30 → 7 → 1 and never gets two alerts at once; thresholds are the dedupe key.
 */
function thresholdFor(daysLeft, thresholds) {
  return [...thresholds].sort((a, b) => a - b).find((threshold) => daysLeft <= threshold) ?? null;
}

async function runWarrantyAlerts(today) {
  const widest = Math.max(...WARRANTY_ALERT_DAYS);
  const assets = await Asset.find({ ...LIVE, 'warranty.expiryDate': { $gte: new Date(today), $lte: new Date(today + widest * DAY_MS) } }).limit(500);
  for (const asset of assets) {
    const days = daysUntil(asset.warranty.expiryDate, today);
    const threshold = thresholdFor(days, WARRANTY_ALERT_DAYS);
    // eslint-disable-next-line no-await-in-loop
    if (threshold !== null) await events.warrantyExpiring({ asset, days, threshold });
  }
  return assets.length;
}

async function runLicenseAlerts(today) {
  const widest = Math.max(...LICENSE_ALERT_DAYS);
  const window = { $gte: new Date(today), $lte: new Date(today + widest * DAY_MS) };
  const assets = await Asset.find({ ...LIVE, kind: ASSET_KIND.SOFTWARE, $or: [{ 'license.expiryDate': window }, { 'license.renewalDate': window }] }).limit(500);
  for (const asset of assets) {
    for (const [kind, date] of [['expiry', asset.license.expiryDate], ['renewal', asset.license.renewalDate]]) {
      if (!date || date.getTime() < today || date.getTime() > today + widest * DAY_MS) continue; // eslint-disable-line no-continue
      const days = daysUntil(date, today);
      const threshold = thresholdFor(days, LICENSE_ALERT_DAYS);
      // eslint-disable-next-line no-await-in-loop
      if (threshold !== null) await events.licenseExpiring({ asset, days, threshold, kind });
    }
  }
  return assets.length;
}

async function runMaintenanceAlerts(today) {
  // Scheduled work that has come and gone without being started.
  const overdue = await AssetMaintenance.find({ status: MAINTENANCE_STATUS.SCHEDULED, scheduledDate: { $lt: new Date(today), $gte: new Date(today - 90 * DAY_MS) } }).populate('asset').limit(500);
  for (const record of overdue) {
    // eslint-disable-next-line no-await-in-loop
    if (record.asset && !record.asset.deletedAt) await events.maintenanceOverdue({ asset: record.asset, maintenance: record });
  }
  // Work coming up in the next 3 days: remind the holder and the people who run maintenance, once per date.
  const soon = await AssetMaintenance.find({ status: MAINTENANCE_STATUS.SCHEDULED, scheduledDate: { $gte: new Date(today), $lte: new Date(today + 3 * DAY_MS) } }).populate('asset').limit(500);
  for (const record of soon) {
    if (!record.asset || record.asset.deletedAt) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const managers = await events.assetManagerIds(record.organization);
    // eslint-disable-next-line no-await-in-loop
    await events.maintenanceScheduled({ asset: record.asset, actor: null, maintenance: record, extraRecipients: managers, reminder: true });
  }
  return { overdue: overdue.length, soon: soon.length };
}

/**
 * Daily-style housekeeping, run hourly from the notification tick (one instance at a time, via a lock). Every alert
 * has a deterministic dedupe key, so running it more often than needed is harmless. Also repairs any asset whose
 * holder fields drifted from its assignments (see assetAssignment.service).
 */
async function runAssetJobs({ now = Date.now() } = {}) {
  const today = parseDateOnly(dateOnlyString(now));
  const [warranties, licenses, maintenance, integrity] = await Promise.all([
    runWarrantyAlerts(today), runLicenseAlerts(today), runMaintenanceAlerts(today), reconcileAssignments(),
  ]);
  return { warranties, licenses, maintenance, integrity };
}

module.exports = { runAssetJobs, thresholdFor, todayUtc };
