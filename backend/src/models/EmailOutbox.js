const mongoose = require('mongoose');
const { EMAIL_STATUS } = require('../constants/notification.constants');

/**
 * Durable record of emails that have no notification row to anchor them —
 * the account-security notices sent to people who were blocked or removed
 * (they can't open the app, so there is nothing in-app to retry from).
 *
 * MongoDB is the source of truth: the row is written BEFORE the Redis queue is
 * touched, so a Redis outage (or a crash between the two steps) can never lose
 * the email. The sweeper re-queues rows that never reached the queue, or that
 * were queued long ago and never confirmed sent (e.g. Redis lost its data).
 * Rows hold only the generic notice text, and expire after 30 days.
 */
const emailOutboxSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true }, // deterministic: one row per (type, user, occurrence)
    type: { type: String, required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    html: { type: String, required: true },
    status: { type: String, enum: Object.values(EMAIL_STATUS), default: EMAIL_STATUS.PENDING },
    attempts: { type: Number, default: 0 },
    queuedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailOutboxSchema.index({ status: 1, createdAt: 1 }, { partialFilterExpression: { status: EMAIL_STATUS.PENDING } });
emailOutboxSchema.index({ status: 1, queuedAt: 1 }, { partialFilterExpression: { status: EMAIL_STATUS.QUEUED } });
emailOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('EmailOutbox', emailOutboxSchema);
