const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const Document = require('../models/Document');
const Project = require('../models/Project');
const Team = require('../models/Team');
const { buildAccessContext, resolveDocumentAccess } = require('../utils/documentAccess');

/** Loads the actor's current team + project memberships (2 indexed queries). */
async function loadAccessContext(user) {
  const [teams, projects] = await Promise.all([
    Team.find({ organization: user.organization, $or: [{ members: user._id }, { lead: user._id }] })
      .select('_id')
      .lean(),
    Project.find({
      organization: user.organization,
      deletedAt: null,
      $or: [{ owner: user._id }, { 'members.user': user._id }],
    })
      .select('_id')
      .lean(),
  ]);

  return buildAccessContext(user, {
    teamIds: teams.map((team) => team._id.toString()),
    projectIds: projects.map((project) => project._id.toString()),
  });
}

function assertObjectId(id, label = 'Document') {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
  }
}

/**
 * Fetches a document in the actor's organization and resolves what they may
 * do with it. A document the actor cannot view is reported as 404, not 403,
 * so its existence is not disclosed.
 */
async function getAccessibleDocument(id, actor, { ctx = null, deleted = false, withStorageKey = false } = {}) {
  assertObjectId(id);

  let query = Document.findOne({
    _id: id,
    organization: actor.organization,
    deletedAt: deleted ? { $ne: null } : null,
  });
  if (withStorageKey) {
    query = query.select('+storageKey');
  }
  const document = await query;
  if (!document) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  const context = ctx || (await loadAccessContext(actor));
  const access = resolveDocumentAccess(context, document);
  if (!access.canView) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  return { document, access, ctx: context };
}

function assertCanEdit(access) {
  if (!access.canEdit) {
    throw new AppError('You do not have permission to edit this document', 403, 'FORBIDDEN');
  }
}

function assertCanManage(access) {
  if (!access.canManage) {
    throw new AppError('You do not have permission to manage this document', 403, 'FORBIDDEN');
  }
}

function publicAccess(access) {
  return {
    canEdit: access.canEdit,
    canManage: access.canManage,
    isOwner: access.isOwner,
    sharePermission: access.sharePermission,
  };
}

module.exports = {
  assertCanEdit,
  assertCanManage,
  assertObjectId,
  getAccessibleDocument,
  loadAccessContext,
  publicAccess,
};
