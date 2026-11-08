const { DOCUMENT_ADMIN_ROLES, DOCUMENT_VISIBILITY, ORG_WIDE_PUBLISH_ROLES, SHARE_PERMISSIONS } = require('../constants/document.constants');
const { PERMISSIONS } = require('../constants/permissions');
const { ROLE_PERMISSIONS } = require('../constants/rolePermissions');
const { ROLES } = require('../constants/roles');

/**
 * Document access rules (single place — services never re-implement them).
 *
 * Audience by visibility:
 *   private       owner + people it was explicitly shared with. NOT org admins:
 *                 "private" means private.
 *   team          members/lead of the document's team (+ owner, shared, admins)
 *   project       owner/members of the document's project (+ owner, shared,
 *                 admins). Project *visibility* (org-open projects) does not
 *                 widen this: only real members count.
 *   organization  every active org member with VIEW_DOCUMENT, except guests.
 *
 * Guests (role guest) are the restricted case: they see only documents
 * explicitly shared with them or belonging to a project they are an explicit
 * member of — never "organization" or "team" documents — and can never write.
 *
 * Access is evaluated against *current* team/project membership on every
 * request, so removing someone from a team or project revokes access
 * immediately without touching any document.
 *
 * Org admins (org-admin / admin) can see and manage every non-private
 * document in their org.
 */

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function isSameId(a, b) {
  const idA = idOf(a);
  const idB = idOf(b);
  return Boolean(idA) && Boolean(idB) && idA === idB;
}

function hasPermission(user, permission) {
  return (ROLE_PERMISSIONS[user.role] || []).includes(permission);
}

function isDocumentAdmin(user) {
  return DOCUMENT_ADMIN_ROLES.includes(user.role);
}

function isGuest(user) {
  return user.role === ROLES.GUEST;
}

function canPublishOrgWide(user) {
  return ORG_WIDE_PUBLISH_ROLES.includes(user.role);
}

/** teamIds / projectIds: the user's *current* memberships, as id strings. */
function buildAccessContext(user, { teamIds = [], projectIds = [] } = {}) {
  return { user, teamIds: new Set(teamIds), projectIds: new Set(projectIds) };
}

function getSharePermission(document, userId) {
  const entry = (document.sharedWith || []).find((share) => isSameId(share.user, userId));
  return entry ? entry.permission : null;
}

function resolveDocumentAccess(ctx, document) {
  const { user } = ctx;
  const none = { canView: false, canEdit: false, canManage: false, isOwner: false, sharePermission: null };

  if (!user || !isSameId(user.organization, document.organization)) {
    return none;
  }

  const isOwner = isSameId(user._id, document.owner);
  const sharePermission = getSharePermission(document, user._id);
  const admin = isDocumentAdmin(user);
  const adminCanSee = admin && document.visibility !== DOCUMENT_VISIBILITY.PRIVATE;

  let canView = isOwner || sharePermission !== null || adminCanSee;

  if (!canView && !isGuest(user)) {
    if (document.visibility === DOCUMENT_VISIBILITY.ORGANIZATION) {
      canView = true;
    } else if (document.visibility === DOCUMENT_VISIBILITY.TEAM) {
      canView = ctx.teamIds.has(idOf(document.team));
    }
  }
  if (!canView && document.visibility === DOCUMENT_VISIBILITY.PROJECT) {
    canView = ctx.projectIds.has(idOf(document.project));
  }

  if (!canView) {
    return none;
  }

  const canWriteRole = hasPermission(user, PERMISSIONS.UPLOAD_DOCUMENT);
  const canEdit = canWriteRole && (isOwner || sharePermission === SHARE_PERMISSIONS.EDITOR || adminCanSee);
  const canManage = isOwner || adminCanSee;

  return { canView: true, canEdit, canManage, isOwner, sharePermission };
}

/**
 * Mongo filter fragment (ANDed with { organization, deletedAt } by the
 * caller) selecting exactly the documents resolveDocumentAccess would let the
 * user view. Keep the two in lock-step — the unit tests assert they agree.
 */
function buildDocumentVisibilityFilter(ctx) {
  const { user } = ctx;
  const teamIds = [...ctx.teamIds];
  const projectIds = [...ctx.projectIds];
  const or = [{ owner: user._id }, { 'sharedWith.user': user._id }];

  if (isDocumentAdmin(user)) {
    or.push({
      visibility: {
        $in: [DOCUMENT_VISIBILITY.TEAM, DOCUMENT_VISIBILITY.PROJECT, DOCUMENT_VISIBILITY.ORGANIZATION],
      },
    });
    return { $or: or };
  }

  if (!isGuest(user)) {
    or.push({ visibility: DOCUMENT_VISIBILITY.ORGANIZATION });
    if (teamIds.length) {
      or.push({ visibility: DOCUMENT_VISIBILITY.TEAM, team: { $in: teamIds } });
    }
  }
  if (projectIds.length) {
    or.push({ visibility: DOCUMENT_VISIBILITY.PROJECT, project: { $in: projectIds } });
  }

  return { $or: or };
}

module.exports = {
  buildAccessContext,
  buildDocumentVisibilityFilter,
  canPublishOrgWide,
  hasPermission,
  idOf,
  isDocumentAdmin,
  isGuest,
  isSameId,
  resolveDocumentAccess,
};
