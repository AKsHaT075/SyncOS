const mongoose = require('mongoose');
const { ASSET_ORG_WIDE_ROLES } = require('../constants/asset.constants');
const { PERMISSIONS } = require('../constants/permissions');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');

/**
 * Asset access rules — the single place data scope is decided. Capability still comes from PERMISSIONS (checked
 * by route middleware); this only answers "which assets, and which people, may THIS user act on".
 *
 *   org-wide roles (org-admin, admin, HR) ... every asset in the organization
 *   managers ................................. assets held by people on teams they LEAD, assets owned by (or held by)
 *                                              those teams, and anything they hold themselves
 *   everyone else ............................ only assets they hold (directly, via a team they belong to, or a license seat)
 *   guests ................................... nothing
 *
 * ctx = { user, teamIds:Set, ledTeamIds:Set, ledMemberIds:Set (people on led teams, plus the user), heldAssetIds:Set }
 */

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const isSame = (a, b) => Boolean(idOf(a)) && idOf(a) === idOf(b);

const can = (user, permission) => (ROLE_PERMISSIONS[user.role] || []).includes(permission);
const isOrgWide = (user) => ASSET_ORG_WIDE_ROLES.includes(user.role) && can(user, PERMISSIONS.VIEW_ASSETS);
const canSeeAnyAssets = (user) => can(user, PERMISSIONS.VIEW_ASSETS) || can(user, PERMISSIONS.VIEW_OWN_ASSETS);

function buildAssetContext(user, { teamIds = [], ledTeamIds = [], ledMemberIds = [], heldAssetIds = [] } = {}) {
  const ids = (list) => list.map(idOf).filter(Boolean); // callers may pass ObjectIds or strings
  return {
    user,
    teamIds: new Set(ids(teamIds)),
    ledTeamIds: new Set(ids(ledTeamIds)),
    ledMemberIds: new Set([...ids(ledMemberIds), idOf(user._id)]),
    heldAssetIds: new Set(ids(heldAssetIds)),
  };
}

/** Mongo fragment (ANDed with { organization }) selecting the assets the user may see. */
function buildAssetVisibilityFilter(ctx) {
  const { user } = ctx;
  if (!canSeeAnyAssets(user)) return { _id: { $in: [] } };
  if (isOrgWide(user)) return {};

  // ObjectIds (not strings): the filter is also used in aggregation pipelines, which do not cast.
  const toIds = (set) => [...set].map((id) => new mongoose.Types.ObjectId(id));
  const or = [{ _id: { $in: toIds(ctx.heldAssetIds) } }];
  if (ctx.teamIds.size) or.push({ assignedTeam: { $in: toIds(ctx.teamIds) } });
  if (can(user, PERMISSIONS.VIEW_ASSETS)) {
    // A manager's view: the people and teams they lead.
    if (ctx.ledMemberIds.size) or.push({ assignedUser: { $in: toIds(ctx.ledMemberIds) } });
    if (ctx.ledTeamIds.size) or.push({ team: { $in: toIds(ctx.ledTeamIds) } }, { assignedTeam: { $in: toIds(ctx.ledTeamIds) } });
    // The pool a manager may assign from: available equipment nobody owns, or that a team they lead owns.
    if (can(user, PERMISSIONS.ASSIGN_ASSET)) {
      or.push({ status: { $in: ['AVAILABLE', 'RESERVED'] }, $or: [{ team: null }, { team: { $in: toIds(ctx.ledTeamIds) } }] });
    }
  }
  return { $or: or };
}

function canViewAsset(ctx, asset) {
  const { user } = ctx;
  if (!isSame(user.organization, asset.organization) || !canSeeAnyAssets(user)) return false;
  if (isOrgWide(user)) return true;
  if (ctx.heldAssetIds.has(idOf(asset._id))) return true;
  if (asset.assignedTeam && ctx.teamIds.has(idOf(asset.assignedTeam))) return true;
  if (!can(user, PERMISSIONS.VIEW_ASSETS)) return false;
  const inPool = can(user, PERMISSIONS.ASSIGN_ASSET) && ['AVAILABLE', 'RESERVED'].includes(asset.status) && (!asset.team || ctx.ledTeamIds.has(idOf(asset.team)));
  return Boolean(
    inPool ||
    (asset.assignedUser && ctx.ledMemberIds.has(idOf(asset.assignedUser))) ||
    (asset.team && ctx.ledTeamIds.has(idOf(asset.team))) ||
    (asset.assignedTeam && ctx.ledTeamIds.has(idOf(asset.assignedTeam))),
  );
}

const targetInScope = (ctx, { user = null, team = null }) =>
  (user && ctx.ledMemberIds.has(idOf(user))) || (team && ctx.ledTeamIds.has(idOf(team)));

/**
 * May the actor assign `asset` to this person/team? Org-wide roles: anyone in the org. Managers: only to
 * people/teams they lead, and only equipment that is unowned or owned by a team they lead.
 */
function canAssignTo(ctx, asset, target) {
  const { user } = ctx;
  if (!can(user, PERMISSIONS.ASSIGN_ASSET) || !isSame(user.organization, asset.organization)) return false;
  if (isOrgWide(user)) return true;
  const ownedByLedTeam = !asset.team || ctx.ledTeamIds.has(idOf(asset.team));
  return ownedByLedTeam && Boolean(targetInScope(ctx, target));
}

/** `holder` = the current assignment's { user, team }. A manager may only move things between people they lead. */
function canTransferTo(ctx, asset, holder, target) {
  const { user } = ctx;
  if (!can(user, PERMISSIONS.TRANSFER_ASSET) || !isSame(user.organization, asset.organization)) return false;
  if (isOrgWide(user)) return true;
  return Boolean(targetInScope(ctx, holder)) && Boolean(targetInScope(ctx, target));
}

function canReturnFrom(ctx, asset, holder) {
  const { user } = ctx;
  if (!can(user, PERMISSIONS.RETURN_ASSET) || !isSame(user.organization, asset.organization)) return false;
  return isOrgWide(user) || Boolean(targetInScope(ctx, holder));
}

/** Employees may report a problem with something they hold; people with maintenance rights may on anything they can see. */
function canReportIssue(ctx, asset) {
  const { user } = ctx;
  if (!isSame(user.organization, asset.organization)) return false;
  if (ctx.heldAssetIds.has(idOf(asset._id))) return can(user, PERMISSIONS.VIEW_OWN_ASSETS);
  return can(user, PERMISSIONS.MANAGE_ASSET_MAINTENANCE) && canViewAsset(ctx, asset);
}

module.exports = {
  buildAssetContext,
  buildAssetVisibilityFilter,
  can,
  canAssignTo,
  canReportIssue,
  canReturnFrom,
  canSeeAnyAssets,
  canTransferTo,
  canViewAsset,
  idOf,
  isOrgWide,
  isSame,
};
