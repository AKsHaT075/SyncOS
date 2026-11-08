const asyncHandler = require('../utils/async-handler');
const AppError = require('../utils/app-error');
const hub = require('../services/notificationHub');
const service = require('../services/notification.service');

const ok = (res, payload, status = 200) => res.status(status).json({ success: true, ...payload });

const list = asyncHandler(async (req, res) => ok(res, await service.listNotifications({ user: req.user, ...req.query })));

const unreadCount = asyncHandler(async (req, res) => ok(res, await service.getUnreadCount({ user: req.user })));

const markRead = asyncHandler(async (req, res) => ok(res, await service.markRead({ user: req.user, id: req.params.id })));

const markAllRead = asyncHandler(async (req, res) =>
  ok(res, await service.markAllRead({ user: req.user, category: req.body.category })));

const dismiss = asyncHandler(async (req, res) =>
  ok(res, await service.dismissNotification({ user: req.user, id: req.params.id })));

const getPreferences = asyncHandler(async (req, res) => ok(res, await service.getPreferences({ user: req.user })));

const updatePreferences = asyncHandler(async (req, res) =>
  ok(res, await service.updatePreferences({ user: req.user, updates: req.body })));

/**
 * GET /notifications/stream — Server-Sent Events.
 * Authentication and org-access checks have already run as route middleware
 * (same as every other endpoint). The stream is tied to the access token's
 * lifetime: it ends when the token expires and the client reconnects with a
 * refreshed one, so a revoked session can't hold a stream open.
 */
const stream = asyncHandler(async (req, res) => {
  const { user } = req;
  if (!user.organization) {
    throw new AppError('You are not part of an organization', 403, 'NO_ORGANIZATION');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
  });
  res.write('retry: 5000\n\n'); // client reconnect delay
  req.socket.setTimeout(0);

  await hub.addConnection({
    res,
    userId: user._id,
    organizationId: user.organization,
    expiresAt: req.auth?.exp ? req.auth.exp * 1000 : null,
  });

  hub.writeEvent(res, { event: 'ready', data: { unreadCount: await service.countUnread(user) } });
});

module.exports = { dismiss, getPreferences, list, markAllRead, markRead, stream, unreadCount, updatePreferences };
