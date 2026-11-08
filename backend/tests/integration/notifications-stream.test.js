jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(),
  sendMeetingRequestDecisionEmail: jest.fn(),
}));

const EventEmitter = require('events');
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { AUTH_CONSTANTS } = require('../../src/constants/auth.constants');
const { ROLES } = require('../../src/constants/roles');
const { MAX_CONNECTIONS_PER_USER } = require('../../src/constants/notification.constants');
const Notification = require('../../src/models/Notification');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const { notify } = require('../../src/services/notification.service');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');

const { app, users, createUser, makeAgent, as, tokenFor } = createHarness();

let server;
let port;
let orgA;
let orgB;
const open = [];
const oid = () => new mongoose.Types.ObjectId();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal SSE client: collects parsed events and exposes waitFor(). */
function connect({ token, cookie, path = '/api/v1/notifications/stream' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `${AUTH_CONSTANTS.ACCESS_TOKEN_COOKIE}=${cookie}`;

    const request = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const client = {
        status: res.statusCode, headers: res.headers, events: [], comments: 0, ended: false, body: '', request,
        close: () => request.destroy(),
        waitFor: async (name, predicate = () => true, timeout = 3000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const found = client.events.find((e) => e.event === name && predicate(e.data));
            if (found) return found;
            // eslint-disable-next-line no-await-in-loop
            await sleep(10);
          }
          throw new Error(`timed out waiting for "${name}"; got ${JSON.stringify(client.events.map((e) => e.event))}`);
        },
        all: (name) => client.events.filter((e) => e.event === name),
      };
      open.push(client);
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (res.statusCode !== 200) client.body += chunk;
        buffer += chunk;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        blocks.forEach((block) => {
          const event = { event: 'message', data: null, id: null };
          block.split('\n').forEach((line) => {
            if (line.startsWith(':')) client.comments += 1;
            else if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
            else if (line.startsWith('id: ')) event.id = line.slice(4);
          });
          if (event.data !== null) client.events.push(event);
        });
      });
      res.on('end', () => { client.ended = true; });
      res.on('close', () => { client.ended = true; });
      resolve(client);
    });
    request.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
}

const give = (key, extra = {}) =>
  notify({
    type: 'project.member_removed', organization: orgA._id, recipients: [users[key]._id], actor: users.admin,
    target: { id: oid() }, params: { project: 'Apollo' }, occurrence: `${Date.now()}-${Math.random()}`, ...extra,
  });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Notification.init();
  await Promise.all(['admin', 'empA', 'empB', 'empOtherOrg', 'adminB'].map(makeAgent));
  server = http.createServer(app).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  open.forEach((client) => client.close());
  await hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
  await createRedisClient().quit();
});

beforeEach(async () => {
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empOtherOrg', ROLES.EMPLOYEE);
});

afterEach(async () => {
  open.splice(0).forEach((client) => client.close());
  await sleep(30); // let the server notice the disconnects
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('connection security', () => {
  it('rejects unauthenticated and bad-token connections', async () => {
    expect((await connect()).status).toBe(401);
    expect((await connect({ token: 'garbage' })).status).toBe(401);
    expect((await connect({ token: jwt.sign({ sub: users.empA._id.toString(), tv: 0 }, 'wrong-secret') })).status).toBe(401);
  });

  it('rejects a token whose session was invalidated (tokenVersion bumped)', async () => {
    const token = tokenFor('empA');
    await User.updateOne({ _id: users.empA._id }, { $inc: { tokenVersion: 1 } });
    expect((await connect({ token })).status).toBe(401);
  });

  it('rejects organization-blocked users and deactivated users', async () => {
    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    const blocked = await connect({ token: tokenFor('empA') });
    expect(blocked.status).toBe(403);
    await sleep(30);
    expect(JSON.parse(blocked.body).code).toBe('ORG_BLOCKED');

    await User.updateOne({ _id: users.empB._id }, { isActive: false });
    expect((await connect({ token: tokenFor('empB') })).status).toBe(401);
    expect(hub.connectionCount(users.empA._id)).toBe(0);
  });

  it('rejects users with no organization', async () => {
    await User.updateOne({ _id: users.empA._id }, { organization: null });
    const client = await connect({ token: tokenFor('empA') });
    expect(client.status).toBe(403);
  });

  it('accepts the HTTP-only cookie (what a browser EventSource sends) as well as a bearer token', async () => {
    const viaCookie = await connect({ cookie: tokenFor('empA') });
    expect(viaCookie.status).toBe(200);
    await viaCookie.waitFor('ready');
    const viaBearer = await connect({ token: tokenFor('empB') });
    expect(viaBearer.status).toBe(200);
  });

  it('sends proper SSE headers and a ready event carrying the current unread count', async () => {
    await give('empA');
    await give('empA');
    const client = await connect({ token: tokenFor('empA') });
    expect(client.status).toBe(200);
    expect(client.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(client.headers['cache-control']).toMatch(/no-cache/);
    expect(client.headers['x-accel-buffering']).toBe('no');
    const ready = await client.waitFor('ready');
    expect(ready.data.unreadCount).toBe(2);
  });
});

describe('real-time delivery', () => {
  it('pushes new notifications to the recipient only, with the new unread count', async () => {
    const mine = await connect({ token: tokenFor('empA') });
    const teammate = await connect({ token: tokenFor('empB') });
    const outsider = await connect({ token: tokenFor('empOtherOrg') });
    await Promise.all([mine, teammate, outsider].map((c) => c.waitFor('ready')));

    await give('empA');
    const event = await mine.waitFor('notification.created');
    expect(event.id).toBeTruthy();
    expect(event.data.unreadCount).toBe(1);
    expect(event.data.notification).toMatchObject({
      type: 'project.member_removed', title: 'Removed from a project', read: false, available: true, link: null,
    });
    expect(event.data.notification.message).toContain('Apollo');
    expect(event.data.notification).not.toHaveProperty('recipient');
    expect(event.data.notification).not.toHaveProperty('dedupeKey');

    await give('empA');
    await mine.waitFor('notification.created', (data) => data.unreadCount === 2);

    await sleep(100);
    expect(teammate.all('notification.created')).toHaveLength(0);
    expect(outsider.all('notification.created')).toHaveLength(0);
  });

  it('delivers exactly once even though it is both delivered locally and published on Redis', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await give('empA');
    await client.waitFor('notification.created');
    await sleep(150); // the Redis echo would arrive by now
    expect(client.all('notification.created')).toHaveLength(1);
  });

  it('does not push notifications the preferences suppress', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ categories: { project: { inApp: false } } }).expect(200);
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await give('empA');
    await sleep(120);
    expect(client.all('notification.created')).toHaveLength(0);
  });

  it('keeps several tabs consistent: read / read-all / dismiss reach every open connection', async () => {
    const tabs = [await connect({ token: tokenFor('empA') }), await connect({ cookie: tokenFor('empA') })];
    const otherUser = await connect({ token: tokenFor('empB') });
    await Promise.all([...tabs, otherUser].map((t) => t.waitFor('ready')));

    const [{ created: [first] }, { created: [second] }] = [await give('empA'), await give('empA')];
    await Promise.all(tabs.map((t) => t.waitFor('notification.created', (d) => d.unreadCount === 2)));

    await as('empA').post(`/api/v1/notifications/${first._id}/read`).expect(200);
    for (const tab of tabs) {
      // eslint-disable-next-line no-await-in-loop
      const event = await tab.waitFor('notification.read');
      expect(event.data).toMatchObject({ id: first._id.toString(), unreadCount: 1 });
    }

    await as('empA').delete(`/api/v1/notifications/${second._id}`).expect(200);
    for (const tab of tabs) {
      // eslint-disable-next-line no-await-in-loop
      expect((await tab.waitFor('notification.dismissed')).data).toMatchObject({ id: second._id.toString(), unreadCount: 0 });
    }

    await give('empA');
    await as('empA').post('/api/v1/notifications/read-all').send({}).expect(200);
    for (const tab of tabs) {
      // eslint-disable-next-line no-await-in-loop
      expect((await tab.waitFor('notification.read_all')).data.unreadCount).toBe(0);
    }
    expect(otherUser.all('notification.read')).toHaveLength(0);
    expect(otherUser.all('notification.read_all')).toHaveLength(0);
  });

  it('delivers locally even when Redis publishing fails (and the row is persisted)', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(createRedisClient(), 'publish').mockRejectedValue(new Error('redis down'));

    await give('empA');
    await client.waitFor('notification.created');
    expect(await Notification.countDocuments({ recipient: users.empA._id })).toBe(1);
  });

  it('nothing is lost while disconnected: a reconnecting client resyncs from MongoDB', async () => {
    const before = await connect({ token: tokenFor('empA') });
    await before.waitFor('ready');
    before.close();
    await sleep(50);

    await give('empA'); await give('empA'); await give('empA'); // happen while offline

    const after = await connect({ token: tokenFor('empA') });
    expect((await after.waitFor('ready')).data.unreadCount).toBe(3);
    const list = await as('empA').get('/api/v1/notifications').expect(200);
    expect(list.body.notifications).toHaveLength(3);
  });
});

describe('multiple backend instances (Redis Pub/Sub)', () => {
  const remote = (userId, message, origin = 'another-instance') =>
    createRedisClient().publish(`test:notif:user:${userId}`, JSON.stringify({ origin, message }));

  it('delivers events published by another instance to local connections', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await remote(users.empA._id, { event: { event: 'notification.created', id: 'x1', data: { notification: { id: 'x1' }, unreadCount: 7 } } });
    expect((await client.waitFor('notification.created')).data.unreadCount).toBe(7);
  });

  it('ignores an instance\'s own echo (no duplicates)', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await remote(users.empA._id, { event: { event: 'notification.created', data: { unreadCount: 1 } } }, hub.INSTANCE_ID);
    await sleep(120);
    expect(client.all('notification.created')).toHaveLength(0);
  });

  it('only receives events for its own user channel', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await remote(users.empB._id, { event: { event: 'notification.created', data: { unreadCount: 9 } } });
    await sleep(120);
    expect(client.all('notification.created')).toHaveLength(0);
  });

  it('a "close" control message from another instance (e.g. the user was blocked there) ends local streams', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await remote(users.empA._id, { control: 'close', reason: 'blocked' });
    expect((await client.waitFor('close')).data.reason).toBe('blocked');
    await sleep(50);
    expect(client.ended).toBe(true);
    expect(hub.connectionCount(users.empA._id)).toBe(0);
  });
});

describe('lifecycle & cleanup', () => {
  it('removes a connection when the client goes away', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    expect(hub.connectionCount(users.empA._id)).toBe(1);
    client.close();
    for (let i = 0; i < 50 && hub.connectionCount(users.empA._id) > 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(20);
    }
    expect(hub.connectionCount(users.empA._id)).toBe(0);
  });

  it(`caps concurrent streams per user at ${MAX_CONNECTIONS_PER_USER}, replacing the oldest`, async () => {
    const clients = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const client = await connect({ token: tokenFor('empA') });
      // eslint-disable-next-line no-await-in-loop
      await client.waitFor('ready');
      clients.push(client);
    }
    expect((await clients[0].waitFor('close')).data.reason).toBe('replaced');
    expect(hub.connectionCount(users.empA._id)).toBe(MAX_CONNECTIONS_PER_USER);
    await give('empA');
    await clients[MAX_CONNECTIONS_PER_USER].waitFor('notification.created');
  });

  it('ends the stream when the access token expires, so the client must re-authenticate', async () => {
    const token = jwt.sign({ sub: users.empA._id.toString(), tv: users.empA.tokenVersion, sid: 's' }, env.JWT_SECRET, { expiresIn: 2 });
    const client = await connect({ token });
    await client.waitFor('ready');
    expect((await client.waitFor('close', () => true, 5000)).data.reason).toBe('token_expired');
    await sleep(50);
    expect(client.ended).toBe(true);
    expect(hub.connectionCount(users.empA._id)).toBe(0);
    // The expired token can't reconnect.
    await sleep(1100);
    expect((await connect({ token })).status).toBe(401);
  }, 15000);

  it('blocking a person via the API closes their open streams immediately, and they cannot reconnect', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: true }).expect(200);

    expect((await client.waitFor('close')).data.reason).toBe('blocked');
    expect((await connect({ token: tokenFor('empA') })).status).toBe(403);
  });

  it('removing a person from the organization closes their streams', async () => {
    const client = await connect({ token: tokenFor('empB') });
    await client.waitFor('ready');
    await as('admin').delete(`/api/v1/people/${users.empB._id}`).expect(200);
    expect((await client.waitFor('close')).data.reason).toBe('removed');
  });

  it('shutdown ends every stream', async () => {
    const client = await connect({ token: tokenFor('empA') });
    await client.waitFor('ready');
    await hub.shutdown();
    expect((await client.waitFor('close')).data.reason).toBe('server_shutdown');
  });
});

describe('heartbeat', () => {
  it('writes periodic comments so proxies keep the connection open', async () => {
    jest.resetModules();
    jest.doMock('../../src/constants/notification.constants', () => ({
      ...jest.requireActual('../../src/constants/notification.constants'),
      HEARTBEAT_MS: 30,
    }));
    const freshHub = require('../../src/services/notificationHub');
    const writes = [];
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false, destroyed: false, write: (chunk) => writes.push(chunk), end() { this.writableEnded = true; },
    });
    await freshHub.addConnection({ res, userId: 'hb-user', organizationId: 'org', expiresAt: null });
    await sleep(120);
    expect(writes.filter((chunk) => chunk === ': ping\n\n').length).toBeGreaterThanOrEqual(2);
    res.emit('close');
    const before = writes.length;
    await sleep(80);
    expect(writes.length).toBe(before); // timers cleared on close
    expect(freshHub.connectionCount('hb-user')).toBe(0);
    await freshHub.shutdown();
    jest.dontMock('../../src/constants/notification.constants');
  });
});
