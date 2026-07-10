const AppError = require('../utils/app-error');
const { PRESENCE } = require('../constants/presence.constants');
const User = require('../models/User');
const Session = require('../models/Session');

/**
 * "Offline" is derived, never stored: a user is online/dnd (their manual
 * preference) as long as at least one of their sessions has refreshed
 * within the access-token TTL, otherwise they're offline regardless of
 * what they last picked.
 */
async function resolvePresenceStatus(user) {
  const recentSession = await Session.findOne({ user: user._id, isActive: true })
    .sort({ lastSeenAt: -1 })
    .select('lastSeenAt');

  const isStale =
    !recentSession || Date.now() - recentSession.lastSeenAt.getTime() > PRESENCE.INACTIVITY_THRESHOLD_MS;

  return isStale ? PRESENCE.STATUS.OFFLINE : user.presenceStatus;
}

async function withResolvedStatus(user) {
  const status = await resolvePresenceStatus(user);
  return { ...user.toSafeObject(), status };
}

async function setPresenceStatus(userId, status) {
  if (!PRESENCE.SETTABLE_STATUSES.includes(status)) {
    throw new AppError('Invalid status', 400, 'INVALID_STATUS');
  }

  const user = await User.findByIdAndUpdate(userId, { presenceStatus: status }, { new: true });
  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  return withResolvedStatus(user);
}

module.exports = {
  resolvePresenceStatus,
  setPresenceStatus,
  withResolvedStatus,
};
