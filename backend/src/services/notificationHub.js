const crypto = require('crypto');
const env = require('../config/env');
const { createRedisClient } = require('../config/redis');
const { HEARTBEAT_MS, MAX_CONNECTIONS_PER_USER } = require('../constants/notification.constants');

/**
 * Real-time delivery over Server-Sent Events, bridged through Redis Pub/Sub.
 *
 * MongoDB is the source of truth: everything here is BEST-EFFORT. If Redis or
 * a socket fails, nothing is lost — the notification is already persisted and
 * a reconnecting client refetches the unread count and the first page.
 *
 * Each backend instance keeps its own open SSE responses (`connections`).
 * publish() delivers to local connections immediately and also publishes on
 * `<prefix>:user:<id>` so other instances deliver to theirs. An instance only
 * subscribes to a user's channel while that user has a local connection.
 * Messages carry the origin instance id so an instance ignores its own echo.
 */

const INSTANCE_ID = crypto.randomUUID();
const channelFor = (userId) => `${env.NOTIFICATION_CHANNEL_PREFIX}:user:${userId}`;

const connections = new Map(); // userId -> Set<connection>
const subscribed = new Set(); // userIds this instance is subscribed to
let subscriber = null;
let subscriberPromise = null;

function writeEvent(res, { event, data, id }) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function removeConnection(connection) {
  clearInterval(connection.heartbeat);
  clearTimeout(connection.expiry);
  const set = connections.get(connection.userId);
  if (!set) return;
  set.delete(connection);
  if (set.size === 0) {
    connections.delete(connection.userId);
    unsubscribeUser(connection.userId).catch(() => {});
  }
}

function closeConnection(connection, reason) {
  if (reason) writeEvent(connection.res, { event: 'close', data: { reason } });
  removeConnection(connection);
  try {
    connection.res.end();
  } catch {
    /* already closed */
  }
}

function deliverLocal(userId, message) {
  const set = connections.get(userId);
  if (!set) return 0;

  if (message.control === 'close') {
    [...set].forEach((connection) => closeConnection(connection, message.reason || 'closed'));
    return 0;
  }

  let delivered = 0;
  [...set].forEach((connection) => {
    if (writeEvent(connection.res, message.event)) {
      delivered += 1;
    } else {
      removeConnection(connection);
    }
  });
  return delivered;
}

async function getSubscriber() {
  if (subscriber) return subscriber;
  if (!subscriberPromise) {
    subscriberPromise = (async () => {
      const client = createRedisClient().duplicate();
      client.on('error', (error) => console.error('[notification-hub] subscriber error:', error.message));
      await client.connect();
      subscriber = client;
      return client;
    })().catch((error) => {
      subscriberPromise = null; // allow a later attempt
      throw error;
    });
  }
  return subscriberPromise;
}

function onRemoteMessage(raw, channel) {
  try {
    const payload = JSON.parse(raw);
    if (payload.origin === INSTANCE_ID) return; // our own publish, already delivered locally
    const userId = channel.slice(channelFor('').length);
    deliverLocal(userId, payload.message);
  } catch (error) {
    console.error('[notification-hub] bad pubsub message:', error.message);
  }
}

async function subscribeUser(userId) {
  if (subscribed.has(userId)) return;
  const client = await getSubscriber();
  await client.subscribe(channelFor(userId), onRemoteMessage);
  subscribed.add(userId);
}

async function unsubscribeUser(userId) {
  if (!subscribed.has(userId) || !subscriber) return;
  subscribed.delete(userId);
  await subscriber.unsubscribe(channelFor(userId));
}

/**
 * Registers an authenticated SSE response. `expiresAt` (ms) is the access
 * token's expiry: the stream is closed then, forcing the client through the
 * normal refresh flow, so a revoked or expired session can never keep a
 * stream open indefinitely.
 */
async function addConnection({ res, userId, organizationId, expiresAt }) {
  const connection = { res, userId: String(userId), organizationId: String(organizationId) };

  const set = connections.get(connection.userId) || new Set();
  connections.set(connection.userId, set);
  // Cap concurrent streams per user; drop the oldest (e.g. a stale tab).
  while (set.size >= MAX_CONNECTIONS_PER_USER) {
    closeConnection(set.values().next().value, 'replaced');
  }
  set.add(connection);

  connection.heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return removeConnection(connection);
    try {
      res.write(': ping\n\n');
    } catch {
      removeConnection(connection);
    }
    return undefined;
  }, HEARTBEAT_MS);
  connection.heartbeat.unref?.();

  if (expiresAt) {
    const ttl = Math.max(1000, expiresAt - Date.now());
    connection.expiry = setTimeout(() => closeConnection(connection, 'token_expired'), ttl);
    connection.expiry.unref?.();
  }

  res.on('close', () => removeConnection(connection));

  // Cross-instance delivery is best effort; local delivery works regardless.
  await subscribeUser(connection.userId).catch((error) =>
    console.error('[notification-hub] subscribe failed (local-only delivery):', error.message));

  return connection;
}

/**
 * Sends an event to every open stream of a user, on this and other instances.
 * Never throws: real-time is an optimisation on top of persisted data.
 */
async function publish(userId, event) {
  const message = { event };
  try {
    deliverLocal(String(userId), message);
  } catch (error) {
    console.error('[notification-hub] local delivery failed:', error.message);
  }
  try {
    const client = createRedisClient();
    if (client.isOpen) {
      await client.publish(channelFor(userId), JSON.stringify({ origin: INSTANCE_ID, message }));
    }
  } catch (error) {
    console.error('[notification-hub] publish failed (clients will resync on reconnect):', error.message);
  }
}

/** Drops all of a user's streams on every instance (blocked, removed, signed out). */
async function closeUser(userId, reason = 'access_revoked') {
  const message = { control: 'close', reason };
  deliverLocal(String(userId), message);
  try {
    const client = createRedisClient();
    if (client.isOpen) {
      await client.publish(channelFor(userId), JSON.stringify({ origin: INSTANCE_ID, message }));
    }
  } catch (error) {
    console.error('[notification-hub] close publish failed:', error.message);
  }
}

function connectionCount(userId) {
  return connections.get(String(userId))?.size ?? 0;
}

async function shutdown() {
  [...connections.values()].forEach((set) => [...set].forEach((connection) => closeConnection(connection, 'server_shutdown')));
  subscribed.clear();
  if (subscriber) {
    const client = subscriber;
    subscriber = null;
    subscriberPromise = null;
    await client.quit().catch(() => {});
  }
}

module.exports = {
  INSTANCE_ID,
  addConnection,
  closeUser,
  connectionCount,
  publish,
  shutdown,
  writeEvent,
};
