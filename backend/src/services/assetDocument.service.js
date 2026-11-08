const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { DOCUMENT_KIND } = require('../constants/asset.constants');
const { DOCUMENT_CATEGORIES } = require('../constants/document.constants');
const { PERMISSIONS } = require('../constants/permissions');
const Asset = require('../models/Asset');
const AssetDocument = require('../models/AssetDocument');
const AssetMaintenance = require('../models/AssetMaintenance');
const Document = require('../models/Document');
const { can } = require('../utils/assetAccess');
const { resolveDocumentAccess } = require('../utils/documentAccess');
const { getAccessibleDocument, loadAccessContext } = require('./documentAccess.service');
const { audit, findViewableAsset } = require('./asset.service');
const { fullName, idOf } = require('./assetPresenter');

/**
 * Asset documents are LINKS to the Documents module — no file is stored or copied here. Two checks always apply:
 *   - you must be able to see the ASSET to see its links at all, and
 *   - for each link you must separately be able to see the DOCUMENT (the Documents module's own rules).
 * A document you can't open shows up as "restricted" (no name, no size); a deleted one as "unavailable".
 */

async function listAssetDocuments({ actor, id, maintenanceId }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const filter = { organization: actor.organization, asset: asset._id };
  if (maintenanceId) filter.maintenance = maintenanceId;

  const links = await AssetDocument.find(filter).sort({ createdAt: -1 }).populate('linkedBy', 'firstName lastName').lean();
  if (!links.length) return { documents: [] };

  const documents = await Document.find({ _id: { $in: links.map((link) => link.document) }, organization: actor.organization })
    .select('owner organization name extension category mimeType size visibility team project sharedWith deletedAt')
    .lean();
  const byId = new Map(documents.map((doc) => [idOf(doc._id), doc]));
  const ctx = await loadAccessContext(actor);

  return {
    documents: links.map((link) => {
      const doc = byId.get(idOf(link.document));
      const base = {
        linkId: idOf(link._id), kind: link.kind, maintenanceId: idOf(link.maintenance), linkedAt: link.createdAt,
        linkedBy: link.linkedBy ? fullName(link.linkedBy) : '', documentId: idOf(link.document),
      };
      if (!doc || doc.deletedAt) return { ...base, status: 'unavailable', document: null };
      if (!resolveDocumentAccess(ctx, doc).canView) return { ...base, status: 'restricted', document: null };
      return { ...base, status: 'ok', document: { id: idOf(doc._id), name: doc.name, extension: doc.extension, category: doc.category, mimeType: doc.mimeType, size: doc.size } };
    }),
  };
}

async function linkDocument({ actor, id, body, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  const forMaintenance = body.kind === DOCUMENT_KIND.MAINTENANCE_REPORT || Boolean(body.maintenanceId);
  if (!can(actor, forMaintenance ? PERMISSIONS.MANAGE_ASSET_MAINTENANCE : PERMISSIONS.UPDATE_ASSET)) {
    throw new AppError('You do not have permission to attach documents to this asset', 403, 'FORBIDDEN');
  }

  // You can only attach a document you yourself can see (a hidden or other-organization document is a 404).
  const { document } = await getAccessibleDocument(body.documentId, actor);
  if (body.kind === DOCUMENT_KIND.IMAGE && document.category !== DOCUMENT_CATEGORIES.IMAGE) {
    throw new AppError('The asset image must be a PNG or JPG file', 400, 'NOT_AN_IMAGE');
  }
  if (body.maintenanceId) {
    if (!mongoose.isValidObjectId(body.maintenanceId) || !(await AssetMaintenance.exists({ _id: body.maintenanceId, asset: asset._id, organization: actor.organization }))) {
      throw new AppError('Maintenance record not found', 404, 'NOT_FOUND');
    }
  }

  let link;
  try {
    link = await AssetDocument.create({
      organization: actor.organization, asset: asset._id, maintenance: body.maintenanceId || null, document: document._id, kind: body.kind, linkedBy: actor._id,
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError('This document is already attached to the asset', 409, 'ALREADY_LINKED');
    throw error;
  }
  if (body.kind === DOCUMENT_KIND.IMAGE) await Asset.updateOne({ _id: asset._id }, { $set: { imageDocument: document._id } });

  await audit(actor, req, AUDIT_EVENTS.ASSET_DOCUMENT_LINKED, asset, { document: document.name, kind: body.kind });
  return { linkId: idOf(link._id) };
}

async function unlinkDocument({ actor, id, linkId, req }) {
  const { asset } = await findViewableAsset(id, actor, { populate: false });
  if (!mongoose.isValidObjectId(linkId)) throw new AppError('Link not found', 404, 'NOT_FOUND');
  const link = await AssetDocument.findOne({ _id: linkId, asset: asset._id, organization: actor.organization });
  if (!link) throw new AppError('Link not found', 404, 'NOT_FOUND');
  const needed = link.maintenance || link.kind === DOCUMENT_KIND.MAINTENANCE_REPORT ? PERMISSIONS.MANAGE_ASSET_MAINTENANCE : PERMISSIONS.UPDATE_ASSET;
  if (!can(actor, needed)) throw new AppError('You do not have permission to remove this document', 403, 'FORBIDDEN');

  await link.deleteOne(); // removes the link only; the document itself is untouched
  if (link.kind === DOCUMENT_KIND.IMAGE) await Asset.updateOne({ _id: asset._id, imageDocument: link.document }, { $set: { imageDocument: null } });
  await audit(actor, req, AUDIT_EVENTS.ASSET_DOCUMENT_UNLINKED, asset, { kind: link.kind });
  return { success: true };
}

module.exports = { linkDocument, listAssetDocuments, unlinkDocument };
