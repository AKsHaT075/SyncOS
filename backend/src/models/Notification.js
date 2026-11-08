const mongoose = require('mongoose');
const {
  EMAIL_STATUS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TARGETS,
  RETENTION_DAYS,
} = require('../constants/notification.constants');

const notificationSchema = new mongoose.Schema(
  {
    // Notifications are scoped to (recipient, organization). Every query
    // filters on both, so a user who changes organizations never sees the old one's.
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    type: { type: String, required: true },
    category: { type: String, enum: Object.values(NOTIFICATION_CATEGORIES), required: true },
    // Titles are generic ("Task assigned"); resource names live only in
    // `message`, so it can be withheld if the recipient later loses access.
    title: { type: String, required: true, maxlength: 140 },
    message: { type: String, default: '', maxlength: 400 },

    target: {
      type: { type: String, enum: [...Object.values(NOTIFICATION_TARGETS), null], default: null },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      // Parent project — needed to build task/meeting URLs.
      project: { type: mongoose.Schema.Types.ObjectId, default: null },
    },

    // Deterministic per (type, resource, recipient, occurrence); see notification.service.
    dedupeKey: { type: String, required: true },

    // False when the user turned in-app off but email is still wanted: the
    // row exists for email state/dedupe but is never listed or counted.
    inApp: { type: Boolean, default: true },
    // true until read or dismissed — a plain boolean so the unread count is a
    // cheap indexed equality match.
    unread: { type: Boolean, default: true },
    readAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },

    email: {
      status: { type: String, enum: Object.values(EMAIL_STATUS), default: EMAIL_STATUS.NONE },
      attempts: { type: Number, default: 0 },
      queuedAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
    },

    // Small, whitelisted, non-sensitive extras (e.g. a meeting's start time).
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Idempotency: one row per (recipient, event occurrence). Rows live until the
// TTL below, so a replayed event inside the retention window can't re-notify.
notificationSchema.index({ recipient: 1, dedupeKey: 1 }, { unique: true });
// Feed: newest first for one user in one organization.
notificationSchema.index({ recipient: 1, organization: 1, inApp: 1, dismissedAt: 1, createdAt: -1, _id: -1 });
// Unread badge.
notificationSchema.index({ recipient: 1, organization: 1, unread: 1, inApp: 1 });
// Email reconciliation sweeper: never-queued rows, and queued-but-never-confirmed rows.
notificationSchema.index({ 'email.status': 1, createdAt: 1 }, { partialFilterExpression: { 'email.status': 'pending' } });
notificationSchema.index({ 'email.queuedAt': 1 }, { partialFilterExpression: { 'email.status': 'queued' } });
// Retention for ALL notifications, whatever their read/dismissed state.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
