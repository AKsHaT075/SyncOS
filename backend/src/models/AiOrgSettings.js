const mongoose = require('mongoose');

/**
 * One row per organization. NO row means AI is disabled (the default), so
 * nothing needs backfilling and a new org can never start with AI on.
 *
 * Holds policy only. The provider API key is never stored here (env only).
 */
const aiOrgSettingsSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    enabled: { type: Boolean, default: false },

    // Evidence that an admin saw the disclosure for the provider in use.
    disclosure: {
      version: { type: String, default: null },
      provider: { type: String, default: null },
      acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      acceptedAt: { type: Date, default: null },
    },
    enabledAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },

    // Live organizational data: the assistant may look up tasks, schedule, projects, teams. SEPARATE from `enabled`, default OFF,
    // and only effective while `enabled` is true. A row without these fields (every pre-Phase-8 row) means "off": no migration needed.
    liveDataEnabled: { type: Boolean, default: false },
    liveDataEnabledAt: { type: Date, default: null },
    liveDataDisabledAt: { type: Date, default: null },
    liveDataDisclosure: {
      version: { type: String, default: null },
      acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      acceptedAt: { type: Date, default: null },
    },

    // Total tokens (input + output). null = use the platform default.
    quotas: {
      userDailyTokens: { type: Number, default: null },
      orgMonthlyTokens: { type: Number, default: null },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

aiOrgSettingsSchema.index({ organization: 1 }, { unique: true });
aiOrgSettingsSchema.index({ enabled: 1 });

module.exports = mongoose.model('AiOrgSettings', aiOrgSettingsSchema);
