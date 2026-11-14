const mongoose = require('mongoose');

/**
 * ONE platform-wide row: which embedding space retrieval may use (`activeSpaceId`) and which one is being built
 * (`targetSpaceId`). Switching is a single compare-and-swap on `revision` after the new space is fully populated and
 * validated, so from the application's point of view a migration is atomic - and a failed migration simply never
 * flips the pointer, leaving the previous space exactly as usable as before.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: 'embedding' },
    activeSpaceId: { type: String, default: null },
    targetSpaceId: { type: String, default: null },
    blockedSpaceId: { type: String, default: null }, // an abandoned target: not restarted until an administrator says so
    retiringSpaceId: { type: String, default: null }, // the previous space, kept for a grace period after promotion
    retireAfter: { type: Date, default: null },
    spaces: { type: mongoose.Schema.Types.Mixed, default: {} }, // spaceId -> descriptor (what each id means)
    revision: { type: Number, default: 0 },
    promotedAt: { type: Date, default: null },
    history: {
      type: [{ _id: false, at: Date, action: String, from: String, to: String }],
      default: [],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AiEmbeddingConfig', schema);
