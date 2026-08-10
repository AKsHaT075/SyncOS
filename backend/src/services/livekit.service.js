const { AccessToken, RoomServiceClient, WebhookReceiver } = require('livekit-server-sdk');
const env = require('../config/env');
const AppError = require('../utils/app-error');

const JOIN_TOKEN_TTL = '6h';
const ROOM_EMPTY_TIMEOUT_SECONDS = 300;
const ROOM_MAX_PARTICIPANTS = 50;

function assertConfigured() {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    throw new AppError('Video calling is not configured for this deployment', 503, 'LIVEKIT_NOT_CONFIGURED');
  }
}

function getRoomServiceClient() {
  assertConfigured();
  // RoomServiceClient talks to LiveKit's HTTP API, which lives at the same
  // host as the wss:// signaling URL — swap the scheme rather than asking
  // for a second env var.
  const httpUrl = env.LIVEKIT_URL.replace(/^ws/i, 'http');
  return new RoomServiceClient(httpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

/**
 * Idempotent: LiveKit's createRoom just returns the existing room if one
 * with this name is already live, so callers don't need to check first.
 */
async function ensureRoom(roomName) {
  const client = getRoomServiceClient();
  return client.createRoom({
    name: roomName,
    emptyTimeout: ROOM_EMPTY_TIMEOUT_SECONDS,
    maxParticipants: ROOM_MAX_PARTICIPANTS,
  });
}

async function endRoom(roomName) {
  const client = getRoomServiceClient();
  await client.deleteRoom(roomName).catch((error) => {
    // Room may have already emptied out and closed on its own (emptyTimeout)
    // by the time "End meeting for everyone" is clicked — not an error.
    if (!/not found/i.test(error?.message || '')) {
      throw error;
    }
  });
}

/**
 * Used by the auto-cleanup sweep to check whether anyone is actually still
 * in the room right now — a "not found" here just means the room already
 * closed (e.g. LiveKit's own emptyTimeout beat us to it), which counts as
 * empty rather than an error.
 */
async function listParticipants(roomName) {
  const client = getRoomServiceClient();
  try {
    return await client.listParticipants(roomName);
  } catch (error) {
    if (/not found/i.test(error?.message || '')) {
      return [];
    }
    throw error;
  }
}

/**
 * Disconnects a participant from the live room via LiveKit's server API —
 * distinct from removeParticipant on Meeting (which only edits the invite
 * list for next time). "Not found" here means they'd already left, which
 * is the outcome the caller wanted anyway.
 */
async function removeParticipantFromRoom(roomName, identity) {
  const client = getRoomServiceClient();
  await client.removeParticipant(roomName, identity).catch((error) => {
    if (!/not found/i.test(error?.message || '')) {
      throw error;
    }
  });
}

async function generateJoinToken({ roomName, identity, name, canPublish = true }) {
  assertConfigured();

  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: JOIN_TOKEN_TTL,
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canPublishData: true,
    canSubscribe: true,
  });

  return await token.toJwt();
}

function getWebhookReceiver() {
  assertConfigured();
  return new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

/**
 * `body` must be the raw request body (LiveKit signs the exact bytes it
 * sent) and `authHeader` the `Authorization` header — throws if the
 * signature doesn't verify.
 */
async function verifyWebhookEvent(body, authHeader) {
  const receiver = getWebhookReceiver();
  return receiver.receive(body, authHeader);
}

module.exports = {
  endRoom,
  ensureRoom,
  generateJoinToken,
  listParticipants,
  removeParticipantFromRoom,
  verifyWebhookEvent,
};
