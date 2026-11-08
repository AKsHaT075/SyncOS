const { ASSET_ADMIN_ROLES, ASSET_ORG_WIDE_ROLES, ASSIGNEE_TYPE } = require('../constants/asset.constants');
const Team = require('../models/Team');
const User = require('../models/User');
const { dateOnlyString } = require('../utils/timezone');
const { notify, safely } = require('./notification.service');

/**
 * Asset events → notifications (through the shared notification system). Every function is failure-isolated
 * and uses a deterministic `occurrence` so retries/duplicate job runs can never notify twice.
 */

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const fmtDate = (ms) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));

const base = (asset, actor, extra = {}) => ({
  organization: asset.organization,
  actor,
  target: { id: asset._id },
  resourceId: asset._id,
  params: { asset: asset.name, assetId: asset.assetId, ...extra },
});

/** Org admins/admins (who manage inventory), and optionally HR (who handle people-related asset events). */
async function assetManagerIds(organization, { includeHr = false } = {}) {
  const roles = includeHr ? ASSET_ORG_WIDE_ROLES : ASSET_ADMIN_ROLES;
  const users = await User.find({ organization, role: { $in: roles }, isActive: true, orgBlocked: { $ne: true } }).select('_id').lean();
  return users.map((user) => idOf(user._id));
}

async function assigneeIds({ assigneeType, user, team }) {
  if (assigneeType !== ASSIGNEE_TYPE.TEAM) return [idOf(user)];
  const doc = await Team.findById(team).select('members lead').lean();
  return [...(doc?.members || []).map(idOf), idOf(doc?.lead)].filter(Boolean);
}

const assigned = ({ asset, actor, assignment }) =>
  safely('asset assigned', async () =>
    notify({
      type: 'asset.assigned', recipients: await assigneeIds(assignment), occurrence: `a:${idOf(assignment._id)}`,
      ...base(asset, actor, { when: assignment.expectedReturnAt ? fmtDate(assignment.expectedReturnAt) : '' }),
    }));

const transferred = ({ asset, actor, from, to, newAssignment, toName }) =>
  safely('asset transferred', async () => {
    await notify({ type: 'asset.transferred', recipients: await assigneeIds(newAssignment), occurrence: `t:${idOf(newAssignment._id)}`, ...base(asset, actor) });
    await notify({ type: 'asset.transferred_away', recipients: await assigneeIds(from), occurrence: `t:${idOf(newAssignment._id)}:away`, ...base(asset, actor, { to: toName }) });
    void to;
  });

const returnRequested = ({ asset, actor, assignment, note }) =>
  safely('asset return requested', async () =>
    notify({
      type: 'asset.return_requested', recipients: await assigneeIds(assignment),
      occurrence: `rr:${idOf(assignment._id)}:${dateOnlyString(Date.now())}`, // at most one request per assignment per day
      ...base(asset, actor, { note: note || '' }),
    }));

const returned = ({ asset, actor, assignment, condition }) =>
  safely('asset returned', async () =>
    notify({
      type: 'asset.returned', recipients: await assetManagerIds(asset.organization, { includeHr: true }),
      occurrence: `ret:${idOf(assignment._id)}`, ...base(asset, actor, { condition: String(condition || '').toLowerCase() }),
    }));

const lost = ({ asset, actor }) =>
  safely('asset lost', async () =>
    notify({
      type: 'asset.lost', recipients: await assetManagerIds(asset.organization, { includeHr: true }),
      occurrence: `lost:${asset.statusHistory?.length ?? Date.now()}`, ...base(asset, actor),
    }));

const maintenanceRequested = ({ asset, actor, maintenance }) =>
  safely('maintenance requested', async () =>
    notify({ type: 'asset.maintenance_requested', recipients: await assetManagerIds(asset.organization), occurrence: `mreq:${idOf(maintenance._id)}`, ...base(asset, actor) }));

const maintenanceScheduled = ({ asset, actor, maintenance, extraRecipients = [], reminder = false }) =>
  safely('maintenance scheduled', async () =>
    notify({
      type: 'asset.maintenance_scheduled',
      recipients: [...(await holderIds(asset)), ...extraRecipients],
      // Rescheduling notifies again (new date → new key); the "coming up" reminder has its own key.
      occurrence: `${reminder ? 'mrem' : 'msch'}:${idOf(maintenance._id)}:${maintenance.scheduledDate?.getTime()}`,
      ...base(asset, actor, { when: fmtDate(maintenance.scheduledDate) }),
    }));

const maintenanceDeclined = ({ asset, actor, maintenance, note }) =>
  safely('maintenance declined', () =>
    notify({ type: 'asset.maintenance_declined', recipients: [idOf(maintenance.reportedBy)], occurrence: `mdec:${idOf(maintenance._id)}`, ...base(asset, actor, { note: note || '' }) }));

const maintenanceCompleted = ({ asset, actor, maintenance }) =>
  safely('maintenance completed', async () =>
    notify({
      type: 'asset.maintenance_completed', recipients: [...(await holderIds(asset)), idOf(maintenance.reportedBy)].filter(Boolean),
      occurrence: `mdone:${idOf(maintenance._id)}`, ...base(asset, actor),
    }));

const maintenanceOverdue = ({ asset, maintenance }) =>
  safely('maintenance overdue', async () =>
    notify({
      type: 'asset.maintenance_overdue', recipients: await assetManagerIds(asset.organization),
      occurrence: `movd:${idOf(maintenance._id)}:${maintenance.scheduledDate.getTime()}`, ...base(asset, null, { when: fmtDate(maintenance.scheduledDate) }),
    }));

/** `threshold` (30/7/1) keys the dedupe: one notification per (date, threshold) however often the job runs; `days` is what's left. */
const warrantyExpiring = ({ asset, days, threshold }) =>
  safely('warranty expiring', async () =>
    notify({
      type: 'asset.warranty_expiring', recipients: await assetManagerIds(asset.organization),
      occurrence: `w:${asset.warranty.expiryDate.getTime()}:${threshold}`, ...base(asset, null, { days, when: fmtDate(asset.warranty.expiryDate) }),
    }));

const licenseExpiring = ({ asset, days, threshold, kind }) =>
  safely('license expiring', async () => {
    const date = kind === 'renewal' ? asset.license.renewalDate : asset.license.expiryDate;
    return notify({
      type: 'asset.license_expiring', recipients: await assetManagerIds(asset.organization),
      occurrence: `l:${kind}:${date.getTime()}:${threshold}`, ...base(asset, null, { days, when: fmtDate(date), what: kind === 'renewal' ? 'renewal' : 'license' }),
    });
  });

/** Someone left (or was blocked) while holding assets: tell the people who run offboarding. History is untouched. */
const formerMemberHoldsAssets = ({ organization, person, count, actor }) =>
  safely('former member holds assets', async () =>
    notify({
      type: 'asset.former_member_holds', organization, recipients: await assetManagerIds(organization, { includeHr: true }), actor,
      resourceId: person._id, target: null, occurrence: `fm:${idOf(person._id)}:${count}`,
      params: { person: `${person.firstName} ${person.lastName}`.trim(), count },
    }));

async function holderIds(asset) {
  if (asset.assignedUser) return [idOf(asset.assignedUser)];
  if (asset.assignedTeam) return assigneeIds({ assigneeType: ASSIGNEE_TYPE.TEAM, team: asset.assignedTeam });
  return [];
}

module.exports = {
  assetManagerIds, assigned, formerMemberHoldsAssets, licenseExpiring, lost, maintenanceCompleted, maintenanceDeclined,
  maintenanceOverdue, maintenanceRequested, maintenanceScheduled, returnRequested, returned, transferred, warrantyExpiring,
};
