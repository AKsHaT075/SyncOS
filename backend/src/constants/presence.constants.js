const { AUTH_CONSTANTS } = require('./auth.constants');
const parseTtl = require('../utils/parseTtl');

/**
 * A session counts as "in use" as long as its access token keeps getting
 * refreshed — refresh only happens while the user is actually making
 * requests, so a session's Session.lastSeenAt is already a faithful
 * activity signal. Reusing the access-token TTL as the offline threshold
 * means no separate heartbeat/poll is needed: if nothing has refreshed
 * the session within roughly one access-token lifetime, it's stale.
 */
const PRESENCE = Object.freeze({
  STATUS: {
    ONLINE: 'online',
    DND: 'dnd',
    OFFLINE: 'offline',
  },
  SETTABLE_STATUSES: ['online', 'dnd'],
  INACTIVITY_THRESHOLD_MS: parseTtl(AUTH_CONSTANTS.ACCESS_TOKEN_TTL),
});

module.exports = { PRESENCE };
