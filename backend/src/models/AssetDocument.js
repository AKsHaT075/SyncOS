const mongoose = require('mongoose');
const { DOCUMENT_KIND } = require('../constants/asset.constants');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A LINK from an asset (optionally one of its maintenance records) to a document in the Documents module.
 * The file is stored once, in Documents; this row stores no content. Reading a link re-checks the viewer's
 * access to the document itself, so a link never grants access to the file.
 */
const assetDocumentSchema = new mongoose.Schema(
  {
    organization: { type: ObjectId, ref: 'Organization', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    maintenance: { type: ObjectId, ref: 'AssetMaintenance', default: null },
    document: { type: ObjectId, ref: 'Document', required: true },
    kind: { type: String, enum: Object.values(DOCUMENT_KIND), default: DOCUMENT_KIND.OTHER },
    linkedBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

assetDocumentSchema.index({ asset: 1, document: 1 }, { unique: true });
assetDocumentSchema.index({ organization: 1, document: 1 });
assetDocumentSchema.index({ asset: 1, maintenance: 1, createdAt: -1 });

module.exports = mongoose.model('AssetDocument', assetDocumentSchema);
