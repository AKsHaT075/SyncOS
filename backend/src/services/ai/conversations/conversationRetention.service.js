const env = require('../../../config/env');
const AIConversation = require('../../../models/AIConversation');
const AiMessage = require('../../../models/AiMessage');

/**
 * Retention and housekeeping for conversations (run by the hourly AI jobs; safe to run on several instances).
 *
 *   - ACTIVE conversations with no activity for AI_CONVERSATION_RETENTION_DAYS are deleted (0 = never).
 *   - ARCHIVED conversations are deleted AI_CONVERSATION_ARCHIVED_RETENTION_DAYS after archiving (0 = never).
 *   - A reply whose request died (lease expired) is closed as `incomplete` and the conversation is released.
 * Deletion removes the conversation and all of its messages. Nothing is logged except counts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

async function deleteBatch(filter) {
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await AIConversation.find(filter).select('_id').limit(BATCH).lean();
    if (rows.length === 0) return total;
    const ids = rows.map((r) => r._id);
    // eslint-disable-next-line no-await-in-loop
    await AiMessage.deleteMany({ conversation: { $in: ids } }); // messages first: an orphan message is harmless, a message-less conversation is not worse
    // eslint-disable-next-line no-await-in-loop
    await AIConversation.deleteMany({ _id: { $in: ids } });
    total += ids.length;
    if (rows.length < BATCH) return total;
  }
}

async function purgeExpired(now = new Date()) {
  let active = 0;
  let archived = 0;
  if (env.AI_CONVERSATION_RETENTION_DAYS > 0) {
    active = await deleteBatch({ status: 'active', activeRequestKey: null, lastActivityAt: { $lt: new Date(now.getTime() - env.AI_CONVERSATION_RETENTION_DAYS * DAY_MS) } });
  }
  if (env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS > 0) {
    archived = await deleteBatch({ status: 'archived', archivedAt: { $lt: new Date(now.getTime() - env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS * DAY_MS) } });
  }
  return { active, archived };
}

/** Closes replies stuck in `streaming` because their request died, and frees the conversation. */
async function recoverStale(now = new Date()) {
  const stale = await AIConversation.find({ activeRequestKey: { $type: 'string' }, leaseExpiresAt: { $lt: now } }).select('_id activeRequestKey').limit(BATCH).lean();
  let recovered = 0;
  for (const conversation of stale) {
    // eslint-disable-next-line no-await-in-loop
    await AiMessage.updateMany({ conversation: conversation._id, requestKey: conversation.activeRequestKey, status: 'streaming' }, { $set: { status: 'incomplete', finishReason: 'interrupted' } });
    // eslint-disable-next-line no-await-in-loop
    const released = await AIConversation.updateOne({ _id: conversation._id, activeRequestKey: conversation.activeRequestKey, leaseExpiresAt: { $lt: now } }, { $set: { activeRequestKey: null, leaseExpiresAt: null } });
    recovered += released.modifiedCount;
  }
  return recovered;
}

module.exports = { purgeExpired, recoverStale };
