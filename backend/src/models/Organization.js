const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    logo: {
      type: String,
      default: null,
    },
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro', 'enterprise'],
      default: 'free',
    },
    /**
     * Plan-derived ceilings, set explicitly rather than inferred from `plan`
     * so support/sales can grant exceptions without a code change. Not
     * enforced anywhere yet — billing/usage enforcement is a future step.
     */
    limits: {
      seats: { type: Number, default: 5 },
      aiCredits: { type: Number, default: 0 },
      storageGB: { type: Number, default: 1 },
    },
    featureFlags: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    suspendedReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

organizationSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    name: this.name,
    slug: this.slug,
    logo: this.logo,
    plan: this.plan,
    limits: this.limits,
    featureFlags: this.featureFlags,
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// Platform analytics: organization growth over time.
organizationSchema.index({ createdAt: 1 });

module.exports = mongoose.model('Organization', organizationSchema);
