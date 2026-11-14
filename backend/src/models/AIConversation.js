const mongoose = require('mongoose');

const DEFAULT_TITLE = 'New conversation';

/**
 * A private AI conversation. Owned by exactly one user in exactly one organization; no role (not even org-admin or
 * super-admin) can read it. Every query MUST filter by { _id, organization, user }.
 *
 * `activeRequestKey` / `leaseExpiresAt` are a lease: only one reply is generated per conversation at a time, and a lease
 * that outlives a crashed request expires by itself. `nextSeq` hands out message sequence numbers atomically.
 */
const aiConversationSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: DEFAULT_TITLE, maxlength: 120 },
    titleSource: { type: String, enum: ['auto', 'user'], default: 'auto' }, // an automatic title never overwrites a user's rename
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    archivedAt: { type: Date, default: null },
    nextSeq: { type: Number, default: 1 },
    messageCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date, default: Date.now },
    activeRequestKey: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, strict: true },
);

aiConversationSchema.index({ organization: 1, user: 1, status: 1, lastActivityAt: -1, _id: -1 });
aiConversationSchema.index({ status: 1, lastActivityAt: 1 }); // retention sweep
aiConversationSchema.index({ leaseExpiresAt: 1 }, { partialFilterExpression: { activeRequestKey: { $type: 'string' } } }); // stale-lease sweep

const AIConversation = mongoose.model('AIConversation', aiConversationSchema);
AIConversation.DEFAULT_TITLE = DEFAULT_TITLE;
module.exports = AIConversation;
