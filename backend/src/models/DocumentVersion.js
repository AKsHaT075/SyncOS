const mongoose = require('mongoose');

const documentVersionSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    version: { type: Number, required: true },
    storageKey: { type: String, required: true, select: false },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    checksum: { type: String, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changeNote: { type: String, default: '', trim: true, maxlength: 500 },
    restoredFrom: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

documentVersionSchema.index({ document: 1, version: -1 }, { unique: true });
documentVersionSchema.index({ organization: 1, document: 1 });

documentVersionSchema.methods.toSafeObject = function toSafeObject(currentVersion = null) {
  const uploader = this.uploadedBy;
  return {
    id: this._id.toString(),
    version: this.version,
    isCurrent: currentVersion !== null ? this.version === currentVersion : undefined,
    fileName: this.fileName,
    mimeType: this.mimeType,
    size: this.size,
    changeNote: this.changeNote,
    restoredFrom: this.restoredFrom,
    uploadedBy:
      uploader && uploader.firstName
        ? { id: uploader._id.toString(), fullName: `${uploader.firstName} ${uploader.lastName}`.trim() }
        : { id: uploader ? uploader.toString() : null },
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('DocumentVersion', documentVersionSchema);
