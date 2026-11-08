const env = require('../config/env');
const { EMAIL_STATUS } = require('../constants/notification.constants');
const { ACCOUNT_EMAIL_TYPES, NOTIFICATION_TYPES } = require('../constants/notificationTypes');
const EmailOutbox = require('../models/EmailOutbox');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { buildAccountEmail, buildNotificationEmail } = require('../utils/emailTemplates');
const { enqueueEmail, onJobResult } = require('./email-queue');
const { buildLink } = require('./notificationAccess.service');

const SWEEP_PENDING_AFTER_MS = 2 * 60 * 1000; // never reached the queue
const SWEEP_QUEUED_AFTER_MS = 30 * 60 * 1000; // queued, but never confirmed sent (Redis data loss, lost worker…)
const MAX_SWEEP_ATTEMPTS = 5;

/**
 * Hands a notification's email to the queue.
 *
 * The notification row already exists, so this can fail without losing
 * anything: the row stays `pending` and the sweeper re-queues it. The queue
 * job carries `jobId = notif:<notificationId>`, so even if the sweeper and the
 * original both end up queued, the recipient is emailed once.
 */
async function queueNotificationEmail(notification, user) {
  const def = NOTIFICATION_TYPES[notification.type];
  if (!def || !user?.email) return false;

  const link = def.link ? buildLink(notification.target) : null;
  const url = link ? `${env.CLIENT_URL}${link}` : null;
  const metadata = notification.metadata || {};

  const content = def.renderEmail
    ? def.renderEmail({ p: metadata, url })
    : buildNotificationEmail({ title: notification.title, message: notification.message, url, firstName: user.firstName });

  const queued = await enqueueEmail({
    to: user.email,
    ...content,
    jobId: `notif:${notification._id}`,
    meta: { notificationId: notification._id.toString() },
  });

  if (queued) {
    await Notification.updateOne(
      { _id: notification._id, 'email.status': { $in: [EMAIL_STATUS.PENDING, EMAIL_STATUS.QUEUED] } },
      { $set: { 'email.status': EMAIL_STATUS.QUEUED, 'email.queuedAt': new Date() } },
    ).catch(() => {});
  }
  return queued;
}

async function queueOutboxRow(row) {
  const queued = await enqueueEmail({
    to: row.to,
    subject: row.subject,
    text: row.text,
    html: row.html,
    jobId: row.jobId,
    meta: { outboxId: row._id.toString() },
  });
  if (queued) {
    await EmailOutbox.updateOne(
      { _id: row._id, status: { $in: [EMAIL_STATUS.PENDING, EMAIL_STATUS.QUEUED] } },
      { $set: { status: EMAIL_STATUS.QUEUED, queuedAt: new Date() } },
    ).catch(() => {});
  }
  return queued;
}

/**
 * Email-only security notices for people who can no longer open the app
 * (blocked / removed). Nothing is shown in-app and the text reveals only the
 * organization's name.
 *
 * Durability: the email is first persisted to MongoDB (EmailOutbox, one row
 * per (type, user, occurrence) — replays are no-ops), and only then handed to
 * the Redis queue. If Redis is down the row stays `pending` and the sweeper
 * delivers it later. Returns true once the email is durably recorded.
 */
async function sendAccountEmail({ type, user, organizationName, organizationId = null, occurrence }) {
  const template = ACCOUNT_EMAIL_TYPES[type];
  if (!template || !user?.email) return false;

  const { heading, body } = template({ org: organizationName || 'your organization' });
  const content = buildAccountEmail({ heading, body, firstName: user.firstName });
  const jobId = `acct:${type}:${user._id}:${occurrence}`;

  const result = await EmailOutbox.findOneAndUpdate(
    { jobId },
    { $setOnInsert: { jobId, type, organization: organizationId, to: user.email, ...content } },
    { upsert: true, new: true, includeResultMetadata: true, setDefaultsOnInsert: true },
  );
  if (result.lastErrorObject?.updatedExisting) return true; // replay of an event we already recorded

  await queueOutboxRow(result.value); // best effort: on failure the row stays pending for the sweeper
  return true;
}

async function sweepNotifications(now, limit) {
  const stale = await Notification.find({
    $or: [
      { 'email.status': EMAIL_STATUS.PENDING, createdAt: { $lt: new Date(now - SWEEP_PENDING_AFTER_MS) } },
      { 'email.status': EMAIL_STATUS.QUEUED, 'email.queuedAt': { $lt: new Date(now - SWEEP_QUEUED_AFTER_MS) } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  let requeued = 0;
  for (const notification of stale) {
    // eslint-disable-next-line no-await-in-loop
    if (notification.email.attempts >= MAX_SWEEP_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await Notification.updateOne(
        { _id: notification._id },
        { $set: { 'email.status': EMAIL_STATUS.FAILED, 'email.lastError': 'could not be queued' } },
      );
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Notification.updateOne({ _id: notification._id }, { $inc: { 'email.attempts': 1 } });
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findOne({
      _id: notification.recipient,
      organization: notification.organization,
      isActive: true,
      orgBlocked: { $ne: true },
    }).select('email firstName');
    if (!user) {
      // eslint-disable-next-line no-await-in-loop
      await Notification.updateOne({ _id: notification._id }, { $set: { 'email.status': EMAIL_STATUS.NONE } });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await queueNotificationEmail(notification, user)) requeued += 1;
  }
  return { checked: stale.length, requeued };
}

async function sweepOutbox(now, limit) {
  const stale = await EmailOutbox.find({
    $or: [
      { status: EMAIL_STATUS.PENDING, createdAt: { $lt: new Date(now - SWEEP_PENDING_AFTER_MS) } },
      { status: EMAIL_STATUS.QUEUED, queuedAt: { $lt: new Date(now - SWEEP_QUEUED_AFTER_MS) } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  let requeued = 0;
  for (const row of stale) {
    // eslint-disable-next-line no-await-in-loop
    if (row.attempts >= MAX_SWEEP_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await EmailOutbox.updateOne({ _id: row._id }, { $set: { status: EMAIL_STATUS.FAILED, lastError: 'could not be queued' } });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await EmailOutbox.updateOne({ _id: row._id }, { $inc: { attempts: 1 } });
    // eslint-disable-next-line no-await-in-loop
    if (await queueOutboxRow(row)) requeued += 1;
  }
  return { checked: stale.length, requeued };
}

/**
 * Reconciliation for emails that never reached the queue (Redis down at the
 * moment of creation, process crash right after the insert) or that were queued
 * but never confirmed sent. Covers notification emails AND the account-security
 * outbox. Safe to run repeatedly: the queue dedupes by jobId.
 */
async function sweepPendingEmails({ now = Date.now(), limit = 100 } = {}) {
  const [notifications, outbox] = await Promise.all([sweepNotifications(now, limit), sweepOutbox(now, limit)]);
  return { checked: notifications.checked + outbox.checked, requeued: notifications.requeued + outbox.requeued };
}

// Mirror queue outcomes onto the notification / outbox row (delivery state
// only; an email failure never touches the in-app notification).
onJobResult(async ({ job, status, error }) => {
  const message = String(error || '').slice(0, 300);
  const targets = [];
  if (job.meta?.notificationId) targets.push([Notification, job.meta.notificationId, 'email.']);
  if (job.meta?.outboxId) targets.push([EmailOutbox, job.meta.outboxId, '']);

  for (const [Model, id, prefix] of targets) {
    // eslint-disable-next-line no-await-in-loop
    if (status === 'sent') {
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: id }, { $set: { [`${prefix}status`]: EMAIL_STATUS.SENT, [`${prefix}sentAt`]: new Date(), [`${prefix}lastError`]: '' } });
    } else if (status === 'retrying') {
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: id }, { $set: { [`${prefix}lastError`]: message }, $inc: { [`${prefix}attempts`]: 1 } });
    } else if (status === 'failed') {
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: id }, { $set: { [`${prefix}status`]: EMAIL_STATUS.FAILED, [`${prefix}lastError`]: message } });
    }
  }
});

module.exports = { queueNotificationEmail, sendAccountEmail, sweepPendingEmails };
