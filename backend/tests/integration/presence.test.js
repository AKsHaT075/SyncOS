const mongoose = require('mongoose');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { resolvePresenceStatus, setPresenceStatus } = require('../../src/services/presence.service');
const { PRESENCE } = require('../../src/constants/presence.constants');
const User = require('../../src/models/User');
const Session = require('../../src/models/Session');

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function createUser(overrides = {}) {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    passwordHash: 'hashed',
    ...overrides,
  });
}

async function createSession(user, lastSeenAt) {
  return Session.create({
    user: user._id,
    isActive: true,
    lastSeenAt,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
}

describe('resolvePresenceStatus', () => {
  it('is offline when the user has no session at all', async () => {
    const user = await createUser();
    expect(await resolvePresenceStatus(user)).toBe(PRESENCE.STATUS.OFFLINE);
  });

  it('is offline when the most recent session is older than the inactivity threshold', async () => {
    const user = await createUser();
    const staleDate = new Date(Date.now() - PRESENCE.INACTIVITY_THRESHOLD_MS - 60_000);
    await createSession(user, staleDate);

    expect(await resolvePresenceStatus(user)).toBe(PRESENCE.STATUS.OFFLINE);
  });

  it('reflects the manual preference when a session has refreshed recently', async () => {
    const onlineUser = await createUser({ presenceStatus: 'online' });
    await createSession(onlineUser, new Date());
    expect(await resolvePresenceStatus(onlineUser)).toBe('online');

    const dndUser = await createUser({ presenceStatus: 'dnd' });
    await createSession(dndUser, new Date());
    expect(await resolvePresenceStatus(dndUser)).toBe('dnd');
  });

  it('ignores sessions that were revoked', async () => {
    const user = await createUser();
    await Session.create({
      user: user._id,
      isActive: false,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(await resolvePresenceStatus(user)).toBe(PRESENCE.STATUS.OFFLINE);
  });
});

describe('setPresenceStatus', () => {
  it('updates the manual preference and returns the resolved status', async () => {
    const user = await createUser();
    await createSession(user, new Date());

    const result = await setPresenceStatus(user._id, 'dnd');
    expect(result.status).toBe('dnd');
    expect(result.presenceStatus).toBe('dnd');

    const reloaded = await User.findById(user._id);
    expect(reloaded.presenceStatus).toBe('dnd');
  });

  it('rejects "offline" — it is derived, not settable', async () => {
    const user = await createUser();
    await expect(setPresenceStatus(user._id, 'offline')).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });
});
