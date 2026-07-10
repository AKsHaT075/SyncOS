const mongoose = require('mongoose');

const projectResourceSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    // Name on disk (uploads/project-resources/<fileName>) — kept separate
    // from originalName so uploads never collide or leak the client's path.
    fileName: {
      type: String,
      required: true,
    },
    originalName: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

projectResourceSchema.index({ project: 1, createdAt: -1 });

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

projectResourceSchema.methods.toSafeObject = function toSafeObject() {
  const uploader = this.uploadedBy;
  const uploadedBy =
    uploader && uploader.firstName
      ? { id: idOf(uploader), fullName: `${uploader.firstName} ${uploader.lastName}`.trim(), email: uploader.email }
      : { id: idOf(uploader) };

  return {
    id: this._id.toString(),
    project: this.project.toString(),
    originalName: this.originalName,
    mimeType: this.mimeType,
    size: this.size,
    uploadedBy,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('ProjectResource', projectResourceSchema);
