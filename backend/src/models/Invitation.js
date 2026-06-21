const mongoose = require('mongoose');

const invitationSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    /**
     * "expired" is never written by a cron — it's derived at read time from
     * (status === 'pending' && expiresAt < now). Keeping `status` limited to
     * states something actually *did* (accepted/revoked) avoids a write race
     * with that derived check.
     */
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked'],
      default: 'pending',
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

invitationSchema.index({ organization: 1, status: 1 });

invitationSchema.methods.effectiveStatus = function effectiveStatus() {
  if (this.status === 'pending' && this.expiresAt.getTime() < Date.now()) {
    return 'expired';
  }
  return this.status;
};

invitationSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    email: this.email,
    role: this.role,
    invitedBy: this.invitedBy.toString(),
    status: this.effectiveStatus(),
    expiresAt: this.expiresAt,
    acceptedAt: this.acceptedAt,
    revokedAt: this.revokedAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Invitation', invitationSchema);
