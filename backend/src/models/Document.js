const mongoose = require('mongoose');
const { DOCUMENT_CATEGORIES, DOCUMENT_VISIBILITY, SHARE_PERMISSIONS } = require('../constants/document.constants');

const shareSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    permission: { type: String, enum: Object.values(SHARE_PERMISSIONS), default: SHARE_PERMISSIONS.VIEWER },
    sharedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sharedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const documentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    folder: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentFolder', default: null },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    visibility: {
      type: String,
      enum: Object.values(DOCUMENT_VISIBILITY),
      default: DOCUMENT_VISIBILITY.PRIVATE,
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    sharedWith: { type: [shareSchema], default: [] },

    // Denormalized from the current version so list/download need no join.
    extension: { type: String, required: true },
    category: { type: String, enum: Object.values(DOCUMENT_CATEGORIES), required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    checksum: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    currentVersion: { type: Number, default: 1 },
    // Monotonic counter for new version numbers (never reused after a failed write).
    versionSeq: { type: Number, default: 1 },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trashedWithFolder: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentFolder', default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Folder browsing + default sort.
documentSchema.index({ organization: 1, deletedAt: 1, folder: 1, name: 1 });
// "My documents" and owner filter.
documentSchema.index({ organization: 1, deletedAt: 1, owner: 1, createdAt: -1 });
// Type filter / recency sort.
documentSchema.index({ organization: 1, deletedAt: 1, category: 1, updatedAt: -1 });
// Visibility fan-out for team / project documents.
documentSchema.index({ organization: 1, deletedAt: 1, visibility: 1, team: 1, project: 1 });
// "Shared with me".
documentSchema.index({ organization: 1, 'sharedWith.user': 1, deletedAt: 1 });
// Trash views.
documentSchema.index({ organization: 1, deletedAt: 1, trashedWithFolder: 1 });

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function personOf(value) {
  if (value && value.firstName) {
    return { id: idOf(value), fullName: `${value.firstName} ${value.lastName}`.trim(), email: value.email };
  }
  return value ? { id: idOf(value) } : null;
}

documentSchema.methods.toSafeObject = function toSafeObject(access = null) {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    folder: idOf(this.folder),
    owner: personOf(this.owner),
    visibility: this.visibility,
    team: this.team ? { id: idOf(this.team), name: this.team.name || null } : null,
    project: this.project ? { id: idOf(this.project), name: this.project.name || null } : null,
    extension: this.extension,
    category: this.category,
    mimeType: this.mimeType,
    size: this.size,
    currentVersion: this.currentVersion,
    sharedCount: this.sharedWith.length,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    deletedAt: this.deletedAt,
    access,
  };
};

module.exports = mongoose.model('Document', documentSchema);
