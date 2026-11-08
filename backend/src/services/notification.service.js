const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const {
  CONFIGURABLE_CATEGORIES,
  DEFAULT_PAGE_SIZE,
  EMAIL_STATUS,
  NOTIFICATION_CATEGORIES,
  RETENTION_MS,
  UNREAD_COUNT_CAP,
} = require('../constants/notification.constants');
const { NOTIFICATION_TYPES } = require('../constants/notificationTypes');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const User = require('../models/User');
const hub = require('./notificationHub');
const { buildLink, resolveAccess } = require('./notificationAccess.service');
const { queueNotificationEmail } = require('./notificationEmail.service');

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const clip = (value, max) => String(value ?? '').slice(0, max);
const fullName = (user) => (user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '');
const cutoff = () => new Date(Date.now() - RETENTION_MS);

// Only these `params` survive into stored metadata — never free-form data.
const METADATA_KEYS = ['status', 'role', 'permission', 'startTime', 'minutes', 'restored', 'version', 'topic', 'project', 'remarks', 'event', 'when'];
const PUBLIC_METADATA_KEYS = ['status', 'role', 'permission', 'startTime', 'minutes', 'restored', 'version'];

const DEFAULT_PREFERENCES = Object.freeze({
  channels: { inApp: true, email: true },
  categories: Object.fromEntries(CONFIGURABLE_CATEGORIES.map((category) => [category, { inApp: true, email: true }])),
});

// ---- preferences ----------------------------------------------------------

function mergePreferences(doc) {
  const source = doc || {};
  return {
    channels: { ...DEFAULT_PREFERENCES.channels, ...(source.channels || {}) },
    categories: Object.fromEntries(
      CONFIGURABLE_CATEGORIES.map((category) => [
        category,
        { ...DEFAULT_PREFERENCES.categories[category], ...(source.categories?.[category] || {}) },
      ]),
    ),
  };
}

/**
 * Which channels a notification type may use for a recipient. Security
 * notifications ignore every preference: they are always delivered in-app and,
 * where the type defines an email, always emailed.
 */
function resolveChannels(def, preferenceDoc, { emailRequested = false } = {}) {
  if (def.category === NOTIFICATION_CATEGORIES.SECURITY) {
    return { inApp: def.inApp !== false, email: Boolean(def.email) };
  }
  const prefs = mergePreferences(preferenceDoc);
  const category = prefs.categories[def.category];
  return {
    inApp: prefs.channels.inApp && category.inApp,
    // `emailOptIn` types (event reminders) are emailed only when the caller asked for it.
    email: Boolean(def.email) && (!def.emailOptIn || emailRequested === true) && prefs.channels.email && category.email,
  };
}

async function getPreferences({ user }) {
  if (!user.organization) throw new AppError('You are not part of an organization', 403, 'NO_ORGANIZATION');
  const doc = await NotificationPreference.findOne({ user: user._id, organization: user.organization }).lean();
  return { preferences: mergePreferences(doc), alwaysOn: [NOTIFICATION_CATEGORIES.SECURITY] };
}

async function updatePreferences({ user, updates }) {
  if (!user.organization) throw new AppError('You are not part of an organization', 403, 'NO_ORGANIZATION');

  const $set = {};
  Object.entries(updates.channels || {}).forEach(([channel, value]) => {
    $set[`channels.${channel}`] = value;
  });
  Object.entries(updates.categories || {}).forEach(([category, channels]) => {
    Object.entries(channels).forEach(([channel, value]) => {
      $set[`categories.${category}.${channel}`] = value;
    });
  });

  const doc = await NotificationPreference.findOneAndUpdate(
    { user: user._id, organization: user.organization },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { preferences: mergePreferences(doc), alwaysOn: [NOTIFICATION_CATEGORIES.SECURITY] };
}

// ---- serialisation --------------------------------------------------------

function serializeNotification(notification, access = { link: null, available: true }) {
  const actor = notification.actor && notification.actor.firstName ? notification.actor : null;
  const available = access.available !== false;
  const metadata = {};
  if (available) {
    PUBLIC_METADATA_KEYS.forEach((key) => {
      if (notification.metadata?.[key] !== undefined) metadata[key] = notification.metadata[key];
    });
  }

  return {
    id: notification._id.toString(),
    type: notification.type,
    category: notification.category,
    title: notification.title,
    // If the recipient lost access to the destination, the message (which
    // names it) is withheld — notifications are never a side channel.
    message: available ? notification.message : 'You no longer have access to this item.',
    actor: actor ? { id: idOf(actor), fullName: fullName(actor) } : null,
    link: access.link,
    available,
    read: !notification.unread,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    metadata,
  };
}

// ---- creation -------------------------------------------------------------

/**
 * Deterministic, recipient-specific idempotency key. `occurrence` identifies
 * ONE specific event (a submission/review sub-document id, a share timestamp,
 * a version number…): the same event delivered twice yields the same key and
 * is suppressed, while a genuinely new event (e.g. assigned again after being
 * unassigned) carries a different occurrence and is delivered.
 */
function buildDedupeKey({ type, resourceId, recipientId, occurrence }) {
  if (occurrence === undefined || occurrence === null || occurrence === '') {
    throw new Error(`notify(${type}): an event "occurrence" is required for deduplication`);
  }
  return [type, resourceId || '-', recipientId, occurrence].join(':');
}

async function resolveActor(actor) {
  if (!actor) return { id: null, name: 'Someone' };
  if (actor.firstName) return { id: idOf(actor), name: fullName(actor) || 'Someone' };
  const loaded = await User.findById(idOf(actor)).select('firstName lastName').lean();
  return { id: idOf(actor), name: fullName(loaded) || 'Someone' };
}

async function unreadCountsFor(userIds, organization) {
  const rows = await Notification.aggregate([
    {
      $match: {
        recipient: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) },
        organization: new mongoose.Types.ObjectId(idOf(organization)),
        inApp: true,
        unread: true,
        createdAt: { $gte: cutoff() },
      },
    },
    { $group: { _id: '$recipient', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), Math.min(row.count, UNREAD_COUNT_CAP)]));
}

/**
 * Creates notifications for `recipients`. The ONLY way notifications come
 * into existence — there is no client-facing create endpoint.
 *
 *  1. Recipients are re-validated here (same organization, active, not
 *     blocked) regardless of what the caller passed, and the actor is never
 *     notified about their own action.
 *  2. Rows are persisted (MongoDB = source of truth) with an idempotent
 *     upsert on (recipient, dedupeKey).
 *  3. Only then is delivery attempted — real-time and email — each step
 *     isolated, so a Redis/SSE/SMTP problem can never lose or undo a
 *     persisted notification.
 */
async function notify({ type, organization, recipients, actor = null, target = null, resourceId = null, params = {}, occurrence, allowSelf = false, emailRequested = false }) {
  const def = NOTIFICATION_TYPES[type];
  if (!def) throw new Error(`Unknown notification type "${type}"`);

  const orgId = idOf(organization);
  const resource = idOf(resourceId || target?.id);
  const actorInfo = await resolveActor(actor);

  let ids = [...new Set((recipients || []).map(idOf).filter(Boolean))];
  if (!allowSelf) ids = ids.filter((id) => id !== actorInfo.id);
  ids = ids.filter((id) => mongoose.isValidObjectId(id));
  if (!orgId || ids.length === 0) return { created: [], skipped: 0 };

  const [users, preferenceDocs] = await Promise.all([
    User.find({ _id: { $in: ids }, organization: orgId, isActive: true, orgBlocked: { $ne: true } })
      .select('email firstName lastName')
      .lean(),
    NotificationPreference.find({ user: { $in: ids }, organization: orgId }).lean(),
  ]);
  const preferencesByUser = new Map(preferenceDocs.map((doc) => [doc.user.toString(), doc]));

  const metadata = {};
  METADATA_KEYS.forEach((key) => {
    if (params[key] !== undefined) metadata[key] = params[key] instanceof Date ? params[key].toISOString() : params[key];
  });
  const safeParams = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? clip(value, 140) : value]),
  );

  const candidates = [];
  users.forEach((user) => {
    const recipientId = user._id.toString();
    const channels = resolveChannels(def, preferencesByUser.get(recipientId), { emailRequested });
    if (!channels.inApp && !channels.email) return;
    candidates.push({
      user,
      channels,
      doc: {
        organization: orgId,
        recipient: recipientId,
        actor: actorInfo.id,
        type,
        category: def.category,
        title: def.title,
        message: clip(def.message({ actor: actorInfo.name, p: safeParams, recipient: user }), 400),
        target: { type: def.target || null, id: resource, project: idOf(target?.project) },
        dedupeKey: buildDedupeKey({ type, resourceId: resource, recipientId, occurrence }),
        inApp: channels.inApp,
        unread: channels.inApp,
        email: { status: channels.email ? EMAIL_STATUS.PENDING : EMAIL_STATUS.NONE },
        metadata,
      },
    });
  });

  // Idempotent persist.
  const created = [];
  for (let i = 0; i < candidates.length; i += 50) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      candidates.slice(i, i + 50).map(async ({ user, channels, doc }) => {
        try {
          const result = await Notification.findOneAndUpdate(
            { recipient: doc.recipient, dedupeKey: doc.dedupeKey },
            { $setOnInsert: doc },
            { upsert: true, new: true, includeResultMetadata: true, setDefaultsOnInsert: true },
          );
          if (!result.lastErrorObject?.updatedExisting) {
            created.push({ notification: result.value, user, channels });
          }
        } catch (error) {
          if (error.code !== 11000) throw error; // lost a race to an identical event: that's a dedupe hit
        }
      }),
    );
  }

  await deliver({ created, organization: orgId, actorInfo }).catch((error) =>
    console.error('[notifications] delivery step failed (notifications are persisted):', error.message));

  return { created: created.map(({ notification }) => notification), skipped: candidates.length - created.length };
}

async function deliver({ created, organization, actorInfo }) {
  if (created.length === 0) return;

  const inAppRecipients = created.filter(({ channels }) => channels.inApp).map(({ user }) => user._id.toString());
  let counts = new Map();
  if (inAppRecipients.length) {
    counts = await unreadCountsFor(inAppRecipients, organization).catch(() => new Map());
  }

  await Promise.all(
    created.map(async ({ notification, user, channels }) => {
      if (channels.inApp) {
        const link = NOTIFICATION_TYPES[notification.type]?.link ? buildLink(notification.target) : null;
        const hydrated = { ...notification.toObject(), actor: actorInfo.id ? { _id: actorInfo.id, ...splitName(actorInfo.name) } : null };
        await hub.publish(user._id.toString(), {
          event: 'notification.created',
          id: notification._id.toString(),
          data: {
            notification: serializeNotification(hydrated, { link, available: true }),
            unreadCount: counts.get(user._id.toString()) ?? 1,
          },
        });
      }
      if (channels.email) {
        await queueNotificationEmail(notification, user);
      }
    }),
  );
}

function splitName(name) {
  const [firstName, ...rest] = name.split(' ');
  return { firstName, lastName: rest.join(' ') };
}

/** Wraps a trigger so a notification problem can never fail the business operation. */
async function safely(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[notifications] ${label} failed:`, error.message);
    return null;
  }
}

// ---- reading --------------------------------------------------------------

function encodeCursor(doc) {
  return Buffer.from(`${doc.createdAt.getTime()}:${doc._id.toString()}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [time, id] = Buffer.from(cursor, 'base64url').toString().split(':');
    const date = new Date(Number(time));
    if (Number.isNaN(date.getTime()) || !mongoose.isValidObjectId(id)) throw new Error('bad cursor');
    return { date, id: new mongoose.Types.ObjectId(id) };
  } catch {
    throw new AppError('Invalid cursor', 400, 'INVALID_CURSOR');
  }
}

function ownScope(user) {
  return { recipient: user._id, organization: user.organization };
}

async function countUnread(user) {
  if (!user.organization) return 0;
  const count = await Notification.countDocuments({
    ...ownScope(user),
    inApp: true,
    unread: true,
    dismissedAt: null,
    createdAt: { $gte: cutoff() },
  }).limit(UNREAD_COUNT_CAP);
  return Math.min(count, UNREAD_COUNT_CAP);
}

async function getUnreadCount({ user }) {
  const count = await countUnread(user);
  return { count, capped: count >= UNREAD_COUNT_CAP };
}

async function listNotifications({ user, cursor, limit = DEFAULT_PAGE_SIZE, status = 'all', category }) {
  if (!user.organization) {
    return { notifications: [], nextCursor: null, unreadCount: 0 };
  }

  const filter = { ...ownScope(user), inApp: true, dismissedAt: null, createdAt: { $gte: cutoff() } };
  if (status === 'unread') filter.unread = true;
  if (category) filter.category = category;
  if (cursor) {
    const { date, id } = decodeCursor(cursor);
    filter.$or = [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: id } }];
  }

  const [rows, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate('actor', 'firstName lastName')
      .lean(),
    countUnread(user),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const access = await resolveAccess(user, page);

  return {
    notifications: page.map((row) => serializeNotification(row, access.get(row._id.toString()))),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    unreadCount,
  };
}

// ---- mutations (always limited to the caller's own rows) -------------------

function assertValidId(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError('Notification not found', 404, 'NOT_FOUND');
  }
}

async function publishSync(user, event, data) {
  await hub.publish(user._id.toString(), { event, data: { ...data, unreadCount: await countUnread(user) } });
}

async function markRead({ user, id }) {
  assertValidId(id);
  const scope = { _id: id, ...ownScope(user), inApp: true, dismissedAt: null };
  const result = await Notification.updateOne({ ...scope, unread: true }, { $set: { unread: false, readAt: new Date() } });
  if (result.matchedCount === 0 && !(await Notification.exists(scope))) {
    // Someone else's id, a dismissed one, and a nonexistent one are indistinguishable.
    throw new AppError('Notification not found', 404, 'NOT_FOUND');
  }
  await publishSync(user, 'notification.read', { id });
  return { success: true, unreadCount: await countUnread(user) };
}

async function markAllRead({ user, category }) {
  const filter = { ...ownScope(user), inApp: true, unread: true, dismissedAt: null };
  if (category) filter.category = category;
  const result = await Notification.updateMany(filter, { $set: { unread: false, readAt: new Date() } });
  await publishSync(user, 'notification.read_all', { category: category || null });
  return { success: true, updated: result.modifiedCount, unreadCount: await countUnread(user) };
}

async function dismissNotification({ user, id }) {
  assertValidId(id);
  const scope = { _id: id, ...ownScope(user), inApp: true };
  const result = await Notification.updateOne(
    { ...scope, dismissedAt: null },
    { $set: { dismissedAt: new Date(), unread: false } },
  );
  if (result.matchedCount === 0 && !(await Notification.exists(scope))) {
    throw new AppError('Notification not found', 404, 'NOT_FOUND');
  }
  // The row is kept (soft delete) until retention removes it so a replayed
  // event can't resurrect a notification the user dismissed.
  await publishSync(user, 'notification.dismissed', { id });
  return { success: true, unreadCount: await countUnread(user) };
}

module.exports = {
  DEFAULT_PREFERENCES,
  buildDedupeKey,
  countUnread,
  dismissNotification,
  getPreferences,
  getUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
  mergePreferences,
  notify,
  resolveChannels,
  safely,
  serializeNotification,
  updatePreferences,
};
