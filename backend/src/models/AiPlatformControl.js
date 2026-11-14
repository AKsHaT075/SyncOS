const mongoose = require('mongoose');

/**
 * ONE platform-wide row: the EMERGENCY switches for AI. Distinct from the organization settings (`aiEnabled`, `liveDataEnabled`), which stay in
 * force on their own, and from the deploy-time activation flag (AI_LIVE_TOOLS_ENABLED). Changed only by a super-admin through
 * PUT /api/v1/ai/platform/control. A missing row means "nothing is switched off"; an UNREADABLE row is treated as "everything is off"
 * (see aiPlatformControl.service). The row never holds prompts, results or any tenant content.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: 'platform' },
    aiDisabled: { type: Boolean, default: false }, // stops ALL AI: new requests are refused, tool callbacks are refused
    liveToolsDisabled: { type: Boolean, default: false }, // stops live organizational tools only (plain chat / document answers keep working)
    reason: { type: String, enum: ['incident', 'maintenance', 'security', 'other', null], default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

module.exports = mongoose.models.AiPlatformControl || mongoose.model('AiPlatformControl', schema);
