const mongoose = require('mongoose');

const documentFolderSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    // null = library root.
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentFolder', default: null },
    // Materialized path (root → direct parent). Makes breadcrumbs, cycle
    // detection and subtree operations single indexed queries.
    ancestors: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Set on items soft-deleted as a side effect of deleting this folder, so
    // restoring the folder restores exactly those items and nothing else.
    trashedWithFolder: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentFolder', default: null },
  },
  { timestamps: true },
);

documentFolderSchema.index({ organization: 1, parent: 1, deletedAt: 1, name: 1 });
documentFolderSchema.index({ organization: 1, ancestors: 1 });
documentFolderSchema.index({ organization: 1, deletedAt: 1, trashedWithFolder: 1 });

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

documentFolderSchema.methods.toSafeObject = function toSafeObject() {
  const owner = this.owner;
  return {
    id: this._id.toString(),
    name: this.name,
    parent: idOf(this.parent),
    owner:
      owner && owner.firstName
        ? { id: idOf(owner), fullName: `${owner.firstName} ${owner.lastName}`.trim() }
        : { id: idOf(owner) },
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    deletedAt: this.deletedAt,
  };
};

module.exports = mongoose.model('DocumentFolder', documentFolderSchema);
