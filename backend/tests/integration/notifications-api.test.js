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

const mongoose = require('mongoose');
const emailService = require('../../src/services/email.service');
const queue = require('../../src/services/email-queue');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { RETENTION_DAYS } = require('../../src/constants/notification.constants');
const Document = require('../../src/models/Document');
const Notification = require('../../src/models/Notification');
const NotificationPreference = require('../../src/models/NotificationPreference');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const { buildDedupeKey, notify } = require('../../src/services/notification.service');
const { sweepPendingEmails } = require('../../src/services/notificationEmail.service');

const { app, users, createUser, makeAgent, as } = createHarness();
void app;

let orgA;
let orgB;
let seq = 0;

const oid = () => new mongoose.Types.ObjectId();

// A notification whose destination needs no real resource (it never links).
function give(recipientKey, overrides = {}) {
  seq += 1;
  return notify({
    type: 'project.member_removed',
    organization: orgA._id,
    recipients: [users[recipientKey]._id],
    actor: users.admin,
    target: { id: oid() },
    params: { project: `Project ${seq}` },
    occurrence: `seq-${seq}`,
    ...overrides,
  });
}

async function flushEmailKeys() {
  const client = createRedisClient();
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all([Notification.init(), NotificationPreference.init()]);
  await Promise.all(['admin', 'manager', 'empA', 'empB', 'guest', 'adminB', 'empOtherOrg'].map(makeAgent));
});

afterAll(async () => {
  await hub.shutdown();
  await flushEmailKeys();
  await disconnectTestDb();
  await createRedisClient().quit();
});

beforeEach(async () => {
  seq = 0;
  await flushEmailKeys();
  emailService.sendEmail.mockReset().mockResolvedValue({ ok: true });
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empOtherOrg', ROLES.EMPLOYEE);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('creation & recipient validation', () => {
  it('persists a complete, correctly scoped notification', async () => {
    const taskId = oid();
    const projectId = oid();
    const { created } = await notify({
      type: 'task.assigned',
      organization: orgA._id,
      recipients: [users.empA._id],
      actor: users.manager,
      target: { id: taskId, project: projectId },
      params: { task: 'Fix login', project: 'Apollo' },
      occurrence: 1,
    });

    expect(created).toHaveLength(1);
    const row = await Notification.findOne({ recipient: users.empA._id }).lean();
    expect(row).toMatchObject({
      type: 'task.assigned',
      category: 'task',
      title: 'Task assigned',
      message: 'Manager Tester assigned you “Fix login” in Apollo.',
      inApp: true,
      unread: true,
      readAt: null,
      dismissedAt: null,
    });
    expect(row.organization.toString()).toBe(orgA._id.toString());
    expect(row.actor.toString()).toBe(users.manager._id.toString());
    expect(row.target).toMatchObject({ type: 'task' });
    expect(row.target.id.toString()).toBe(taskId.toString());
    expect(row.target.project.toString()).toBe(projectId.toString());
    expect(row.dedupeKey).toBe(`task.assigned:${taskId}:${users.empA._id}:1`);
    expect(row.createdAt).toBeInstanceOf(Date); // required for the retention TTL
    expect(row.email.status).toBe('queued'); // email-eligible and handed to the queue
  });

  it('only creates notifications for valid recipients in the SAME organization', async () => {
    await User.updateOne({ _id: users.guest._id }, { orgBlocked: true });
    await User.updateOne({ _id: users.empB._id }, { isActive: false });

    const result = await give('empA', {
      recipients: [
        users.empA._id, // valid
        users.empOtherOrg._id, // other organization
        users.guest._id, // blocked
        users.empB._id, // deactivated
        oid(), // does not exist
        'not-an-id',
        users.admin._id, // the actor: never notified about their own action
        users.empA._id, // duplicate
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(await Notification.countDocuments()).toBe(1);
    expect(await Notification.countDocuments({ recipient: users.empOtherOrg._id })).toBe(0);
  });

  it('never accepts an unknown type or a missing occurrence', async () => {
    await expect(give('empA', { type: 'made.up' })).rejects.toThrow(/Unknown notification type/);
    await expect(give('empA', { occurrence: undefined })).rejects.toThrow(/occurrence/);
  });

  it('exposes no endpoint for clients to create notifications', async () => {
    const res = await as('empA').post('/api/v1/notifications').send({ recipient: users.empB._id, title: 'x' });
    expect(res.status).toBe(404);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe('listing, pagination, unread counts', () => {
  it('lists only my notifications, newest first, with the unread count', async () => {
    await give('empA');
    await give('empA');
    await give('empB');

    const res = await as('empA').get('/api/v1/notifications').expect(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    const [first, second] = res.body.notifications;
    expect(new Date(first.createdAt) >= new Date(second.createdAt)).toBe(true);
    expect(first).toMatchObject({ read: false, available: true, category: 'project', link: null });
    expect(first.actor.fullName).toBe('Admin Tester');
    expect(first).not.toHaveProperty('dedupeKey');
    expect(first).not.toHaveProperty('recipient');
    expect(first).not.toHaveProperty('organization');
  });

  it('pages with a stable cursor: no gaps, no duplicates', async () => {
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await give('empA');
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await as('empA').get(`/api/v1/notifications?limit=3${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      seen.push(...res.body.notifications.map((n) => n.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('keeps pagination correct when new notifications arrive between pages', async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await give('empA');
    }
    const first = await as('empA').get('/api/v1/notifications?limit=2').expect(200);
    await give('empA'); // lands at the top, must not shift the next page
    const second = await as('empA').get(`/api/v1/notifications?limit=2&cursor=${first.body.nextCursor}`).expect(200);
    const ids = [...first.body.notifications, ...second.body.notifications].map((n) => n.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('filters by unread status and by category', async () => {
    const { created } = await give('empA');
    await give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' } });
    await as('empA').post(`/api/v1/notifications/${created[0]._id}/read`).expect(200);

    const unread = await as('empA').get('/api/v1/notifications?status=unread').expect(200);
    expect(unread.body.notifications.map((n) => n.type)).toEqual(['person.role_changed']);
    const projects = await as('empA').get('/api/v1/notifications?category=project').expect(200);
    expect(projects.body.notifications.map((n) => n.type)).toEqual(['project.member_removed']);
  });

  it('rejects malformed queries', async () => {
    await as('empA').get('/api/v1/notifications?limit=500').expect(400);
    await as('empA').get('/api/v1/notifications?status=everything').expect(400);
    await as('empA').get('/api/v1/notifications?recipient=someoneElse').expect(400);
    const bad = await as('empA').get('/api/v1/notifications?cursor=garbage').expect(400);
    expect(bad.body.code).toBe('INVALID_CURSOR');
  });

  it('counts unread, capped at 100', async () => {
    const rows = Array.from({ length: 105 }, (_, i) => ({
      organization: orgA._id, recipient: users.empA._id, type: 'project.member_removed', category: 'project',
      title: 't', message: 'm', dedupeKey: `bulk:${i}`, createdAt: new Date(),
    }));
    await Notification.insertMany(rows);
    const res = await as('empA').get('/api/v1/notifications/unread-count').expect(200);
    expect(res.body).toMatchObject({ count: 100, capped: true });

    await give('empB');
    expect((await as('empB').get('/api/v1/notifications/unread-count').expect(200)).body).toMatchObject({ count: 1, capped: false });
  });
});

describe('read / read-all / dismiss', () => {
  it('marks one notification read (idempotently) and updates the count', async () => {
    const { created } = await give('empA');
    await give('empA');
    const id = created[0]._id.toString();

    const first = await as('empA').post(`/api/v1/notifications/${id}/read`).expect(200);
    expect(first.body.unreadCount).toBe(1);
    const readAt = (await Notification.findById(id)).readAt;
    expect(readAt).toBeInstanceOf(Date);

    await as('empA').post(`/api/v1/notifications/${id}/read`).expect(200); // idempotent
    expect((await Notification.findById(id)).readAt.getTime()).toBe(readAt.getTime());

    const list = await as('empA').get('/api/v1/notifications').expect(200);
    expect(list.body.notifications.find((n) => n.id === id).read).toBe(true);
  });

  it('marks everything read, optionally for one category only', async () => {
    await give('empA');
    await give('empA');
    await give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' } });

    const one = await as('empA').post('/api/v1/notifications/read-all').send({ category: 'team' }).expect(200);
    expect(one.body).toMatchObject({ updated: 1, unreadCount: 2 });
    const all = await as('empA').post('/api/v1/notifications/read-all').send({}).expect(200);
    expect(all.body).toMatchObject({ updated: 2, unreadCount: 0 });
    await as('empA').post('/api/v1/notifications/read-all').send({ category: 'bogus' }).expect(400);
  });

  it('read-all only touches my own notifications', async () => {
    await give('empA');
    await give('empB');
    await as('empA').post('/api/v1/notifications/read-all').send({}).expect(200);
    expect(await Notification.countDocuments({ recipient: users.empB._id, unread: true })).toBe(1);
  });

  it('dismisses a notification: gone from list and count, kept for dedupe until retention', async () => {
    const { created } = await give('empA');
    const id = created[0]._id.toString();
    await give('empA');

    const res = await as('empA').delete(`/api/v1/notifications/${id}`).expect(200);
    expect(res.body.unreadCount).toBe(1);
    const list = await as('empA').get('/api/v1/notifications').expect(200);
    expect(list.body.notifications.map((n) => n.id)).not.toContain(id);
    expect(await Notification.countDocuments({ _id: id })).toBe(1); // soft delete

    await as('empA').delete(`/api/v1/notifications/${id}`).expect(200); // idempotent
    await as('empA').post(`/api/v1/notifications/${id}/read`).expect(404); // can't act on a dismissed one
  });

  it('a replayed event cannot resurrect a dismissed notification', async () => {
    const event = { occurrence: 'fixed', target: { id: oid() }, params: { project: 'P' } };
    const { created } = await give('empA', { ...event, resourceId: event.target.id });
    await as('empA').delete(`/api/v1/notifications/${created[0]._id}`).expect(200);

    const replay = await give('empA', { ...event, resourceId: event.target.id });
    expect(replay.created).toHaveLength(0);
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(0);
  });
});

describe('isolation & access control', () => {
  it('another user cannot read, mark, or dismiss my notification by id (always 404)', async () => {
    const { created } = await give('empA');
    const id = created[0]._id.toString();

    for (const key of ['empB', 'admin', 'guest', 'adminB', 'empOtherOrg']) {
      // eslint-disable-next-line no-await-in-loop
      await as(key).post(`/api/v1/notifications/${id}/read`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      await as(key).delete(`/api/v1/notifications/${id}`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      const list = await as(key).get('/api/v1/notifications').expect(200);
      expect(list.body.notifications.map((n) => n.id)).not.toContain(id);
    }
    const stored = await Notification.findById(id);
    expect(stored).toMatchObject({ unread: true, dismissedAt: null });
  });

  it('treats malformed ids exactly like missing ones', async () => {
    await as('empA').post('/api/v1/notifications/not-an-id/read').expect(404);
    await as('empA').delete('/api/v1/notifications/not-an-id').expect(404);
    await as('empA').post(`/api/v1/notifications/${oid()}/read`).expect(404);
  });

  it('keeps organizations apart even for the same person ids / admins', async () => {
    await give('empA');
    await notify({
      type: 'project.member_removed', organization: orgB._id, recipients: [users.empOtherOrg._id],
      actor: users.adminB, target: { id: oid() }, params: { project: 'Globex project' }, occurrence: 'b1',
    });

    expect((await as('adminB').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(0);
    const other = await as('empOtherOrg').get('/api/v1/notifications').expect(200);
    expect(other.body.notifications).toHaveLength(1);
    expect(other.body.notifications[0].message).toContain('Globex project');
  });

  it('a user who moved to another organization does not see the old one\'s notifications', async () => {
    await give('empA');
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(1);
    await User.updateOne({ _id: users.empA._id }, { organization: orgB._id });
    const res = await as('empA').get('/api/v1/notifications').expect(200);
    expect(res.body.notifications).toHaveLength(0);
    expect((await as('empA').get('/api/v1/notifications/unread-count').expect(200)).body.count).toBe(0);
  });

  it('a user with no organization gets empty results, not an error or someone else\'s data', async () => {
    await User.updateOne({ _id: users.empA._id }, { organization: null });
    const res = await as('empA').get('/api/v1/notifications').expect(200);
    expect(res.body).toMatchObject({ notifications: [], unreadCount: 0 });
    await as('empA').get('/api/v1/notifications/preferences').expect(403);
  });

  it('requires authentication and CSRF protection', async () => {
    const request = require('supertest');
    await request(createHarness().app).get('/api/v1/notifications').expect(401);
    await request(createHarness().app).get('/api/v1/notifications/stream').expect(401);
    const { created } = await give('empA');
    await require('supertest').agent(createHarness().app)
      .post(`/api/v1/notifications/${created[0]._id}/read`)
      .set('Authorization', `Bearer ${require('../../src/utils/jwt').signAccessToken({ sub: users.empA._id.toString(), tv: 0, sid: 's' })}`)
      .expect(403); // no CSRF token
  });

  it('blocks organization-blocked users from every notification route', async () => {
    const { created } = await give('empA');
    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    const id = created[0]._id.toString();

    const calls = [
      () => as('empA').get('/api/v1/notifications'),
      () => as('empA').get('/api/v1/notifications/unread-count'),
      () => as('empA').get('/api/v1/notifications/preferences'),
      () => as('empA').put('/api/v1/notifications/preferences').send({ channels: { email: false } }),
      () => as('empA').post(`/api/v1/notifications/${id}/read`),
      () => as('empA').post('/api/v1/notifications/read-all').send({}),
      () => as('empA').delete(`/api/v1/notifications/${id}`),
      () => as('empA').get('/api/v1/notifications/stream'),
    ];
    for (const call of calls) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORG_BLOCKED');
    }
  });
});

describe('links never point somewhere the user may not go', () => {
  async function fixtures() {
    const project = await Project.create({
      organization: orgA._id, owner: users.manager._id, createdBy: users.manager._id, name: 'Apollo', slug: 'apollo',
      visibility: 'Private', members: [{ user: users.empA._id, role: 'Contributor' }],
    });
    const task = await Task.create({
      organization: orgA._id, project: project._id, title: 'Fix login', owner: users.manager._id,
      createdBy: users.manager._id, assignees: [users.empA._id], visibility: 'Public',
    });
    return { project, task };
  }

  const assign = (task, project) =>
    notify({
      type: 'task.assigned', organization: orgA._id, recipients: [users.empA._id], actor: users.manager,
      target: { id: task._id, project: project._id }, params: { task: task.title, project: project.name }, occurrence: 1,
    });

  it('shows the link while the user has access', async () => {
    const { project, task } = await fixtures();
    await assign(task, project);
    const [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n).toMatchObject({ link: `/dashboard/projects/${project._id}/tasks/${task._id}`, available: true });
    expect(n.message).toContain('Fix login');
  });

  it('removes the link and withholds the message once access is lost', async () => {
    const { project, task } = await fixtures();
    await assign(task, project);
    await Project.updateOne({ _id: project._id }, { $pull: { members: { user: users.empA._id } } });
    await Task.updateOne({ _id: task._id }, { $pull: { assignees: users.empA._id } });

    const [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n.link).toBeNull();
    expect(n.available).toBe(false);
    expect(n.message).toBe('You no longer have access to this item.');
    expect(JSON.stringify(n)).not.toMatch(/Fix login|Apollo/);
    expect(n.metadata).toEqual({});
  });

  it('treats deleted and archived-away resources as unavailable', async () => {
    const { project, task } = await fixtures();
    await assign(task, project);
    await Task.updateOne({ _id: task._id }, { deletedAt: new Date() });
    const [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n).toMatchObject({ link: null, available: false });
  });

  it('a notification forged to point at another organization\'s resource exposes nothing', async () => {
    const foreignProject = await Project.create({
      organization: orgB._id, owner: users.adminB._id, createdBy: users.adminB._id, name: 'Top secret', slug: 'ts',
    });
    const foreignTask = await Task.create({
      organization: orgB._id, project: foreignProject._id, title: 'Secret task', owner: users.adminB._id,
      createdBy: users.adminB._id, visibility: 'Public',
    });
    await Notification.create({
      organization: orgA._id, recipient: users.empA._id, type: 'task.assigned', category: 'task', title: 'Task assigned',
      message: 'leaky', dedupeKey: 'forged', target: { type: 'task', id: foreignTask._id, project: foreignProject._id },
    });
    const [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n).toMatchObject({ link: null, available: false });
    expect(JSON.stringify(n)).not.toMatch(/Secret|Top secret|leaky/);
  });

  it('document links follow document access (shared -> revoked)', async () => {
    const doc = await Document.create({
      organization: orgA._id, name: 'Plan.pdf', owner: users.manager._id, visibility: 'private', extension: 'pdf',
      category: 'pdf', mimeType: 'application/pdf', size: 10, checksum: 'x', storageKey: 'k', sharedWith: [{ user: users.empA._id, permission: 'viewer', sharedBy: users.manager._id }],
    });
    await notify({
      type: 'document.shared', organization: orgA._id, recipients: [users.empA._id], actor: users.manager,
      target: { id: doc._id }, params: { document: doc.name, permission: 'viewer' }, occurrence: 1,
    });
    let [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n).toMatchObject({ link: `/dashboard/documents?doc=${doc._id}`, available: true });

    await Document.updateOne({ _id: doc._id }, { $set: { sharedWith: [] } });
    [n] = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(n).toMatchObject({ link: null, available: false });
    expect(n.message).not.toContain('Plan.pdf');
  });
});

describe('deduplication', () => {
  const base = () => ({ target: { id: new mongoose.Types.ObjectId('64b000000000000000000001') }, params: { project: 'P' } });

  it('the same event delivered twice produces one notification', async () => {
    const first = await give('empA', { ...base(), occurrence: 'evt-1' });
    const second = await give('empA', { ...base(), occurrence: 'evt-1' });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toBe(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it('a genuinely new event is not suppressed by an earlier one', async () => {
    await give('empA', { ...base(), occurrence: 'evt-1' });
    await give('empA', { ...base(), occurrence: 'evt-2' });
    expect(await Notification.countDocuments()).toBe(2);
  });

  it('the same event for different recipients is delivered to each', async () => {
    await give('empA', { ...base(), recipients: [users.empA._id, users.empB._id], occurrence: 'evt-1' });
    expect(await Notification.countDocuments()).toBe(2);
    expect(buildDedupeKey({ type: 't', resourceId: 'r', recipientId: 'a', occurrence: 1 }))
      .not.toBe(buildDedupeKey({ type: 't', resourceId: 'r', recipientId: 'b', occurrence: 1 }));
  });

  it('concurrent duplicates (a race) still yield exactly one row and one email job', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' }, occurrence: 'race' })),
    );
    expect(results.reduce((sum, r) => sum + r.created.length, 0)).toBe(1);
    expect(await Notification.countDocuments()).toBe(1);
    const jobs = await createRedisClient().lRange('test:email:queue', 0, -1);
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]).jobId).toBe(`notif:${(await Notification.findOne())._id}`);
  });
});

describe('preferences', () => {
  it('returns sensible defaults without creating anything', async () => {
    const res = await as('empA').get('/api/v1/notifications/preferences').expect(200);
    expect(res.body.preferences.channels).toEqual({ inApp: true, email: true });
    expect(Object.keys(res.body.preferences.categories).sort()).toEqual(['calendar', 'document', 'meeting', 'project', 'task', 'team']);
    expect(res.body.alwaysOn).toEqual(['security']);
    expect(await NotificationPreference.countDocuments()).toBe(0);
  });

  it('persists updates per user and per organization', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ categories: { task: { email: false } } }).expect(200);
    await as('empA').put('/api/v1/notifications/preferences').send({ channels: { inApp: false } }).expect(200);

    const mine = await as('empA').get('/api/v1/notifications/preferences').expect(200);
    expect(mine.body.preferences.categories.task).toEqual({ inApp: true, email: false });
    expect(mine.body.preferences.channels.inApp).toBe(false);
    expect((await as('empB').get('/api/v1/notifications/preferences').expect(200)).body.preferences.channels.inApp).toBe(true);

    const stored = await NotificationPreference.findOne({ user: users.empA._id });
    expect(stored.organization.toString()).toBe(orgA._id.toString());
    expect(await NotificationPreference.countDocuments()).toBe(1);
  });

  it('cannot disable security notifications or smuggle in other fields', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ categories: { security: { inApp: false } } }).expect(400);
    await as('empA').put('/api/v1/notifications/preferences').send({ channels: { sms: true } }).expect(400);
    await as('empA').put('/api/v1/notifications/preferences').send({ user: users.empB._id, channels: { email: false } }).expect(400);
    await as('empA').put('/api/v1/notifications/preferences').send({}).expect(400);
  });

  it('in-app off: nothing listed, email still delivered', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ categories: { team: { inApp: false } } }).expect(200);
    await give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' } });

    const row = await Notification.findOne({ recipient: users.empA._id });
    expect(row).toMatchObject({ inApp: false, unread: false });
    expect(row.email.status).toBe('queued');
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(0);
    expect((await as('empA').get('/api/v1/notifications/unread-count').expect(200)).body.count).toBe(0);
  });

  it('email off: in-app still delivered, nothing queued', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ categories: { team: { email: false } } }).expect(200);
    await give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' } });
    expect((await Notification.findOne()).email.status).toBe('none');
    expect(await createRedisClient().lLen('test:email:queue')).toBe(0);
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(1);
  });

  it('both off: no notification is created at all', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ channels: { inApp: false, email: false } }).expect(200);
    await give('empA');
    await give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'x' } });
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('security notifications are delivered no matter what the preferences say', async () => {
    await as('empA').put('/api/v1/notifications/preferences').send({ channels: { inApp: false, email: false } }).expect(200);
    await notify({
      type: 'security.access_restored', organization: orgA._id, recipients: [users.empA._id], actor: users.admin,
      resourceId: users.empA._id, occurrence: 1,
    });
    await notify({
      type: 'security.password_reset_forced', organization: orgA._id, recipients: [users.empA._id], actor: users.admin,
      resourceId: users.empA._id, occurrence: 1,
    });

    const list = (await as('empA').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(list.map((n) => n.type).sort()).toEqual(['security.access_restored', 'security.password_reset_forced']);
    const restored = await Notification.findOne({ type: 'security.access_restored' });
    expect(restored.email.status).toBe('queued');
  });
});

describe('retention (90 days)', () => {
  const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const row = (key, extra) => ({
    organization: orgA._id, recipient: users.empA._id, type: 'project.member_removed', category: 'project',
    title: 't', message: 'm', dedupeKey: key, ...extra,
  });

  it('has a single TTL index on createdAt covering every notification', async () => {
    const indexes = await Notification.collection.indexes();
    const ttl = indexes.filter((index) => index.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(1);
    expect(ttl[0].key).toEqual({ createdAt: 1 });
    expect(ttl[0].expireAfterSeconds).toBe(RETENTION_DAYS * 24 * 60 * 60);
    expect(ttl[0].partialFilterExpression).toBeUndefined(); // not conditional on read/dismissed state
    expect(RETENTION_DAYS).toBe(90);
  });

  it('never shows or counts notifications past the cutoff, even before Mongo\'s TTL monitor deletes them', async () => {
    await Notification.collection.insertMany([
      row('old-unread', { createdAt: daysAgo(91), unread: true, inApp: true, dismissedAt: null, readAt: null }),
      row('old-read', { createdAt: daysAgo(120), unread: false, inApp: true, dismissedAt: null, readAt: daysAgo(100) }),
      row('fresh', { createdAt: daysAgo(89), unread: true, inApp: true, dismissedAt: null, readAt: null }),
    ]);

    const list = await as('empA').get('/api/v1/notifications').expect(200);
    expect(list.body.notifications).toHaveLength(1);
    expect(list.body.unreadCount).toBe(1);
    expect((await as('empA').get('/api/v1/notifications/unread-count').expect(200)).body.count).toBe(1);
    expect((await as('empA').get('/api/v1/notifications?status=unread').expect(200)).body.notifications).toHaveLength(1);
  });

  it('applies the same cutoff to unread, read and dismissed rows', async () => {
    const cutoffOk = daysAgo(89);
    await Notification.collection.insertMany([
      row('a', { createdAt: cutoffOk, unread: true, inApp: true, dismissedAt: null }),
      row('b', { createdAt: cutoffOk, unread: false, inApp: true, dismissedAt: null, readAt: new Date() }),
      row('c', { createdAt: cutoffOk, unread: false, inApp: true, dismissedAt: new Date() }),
    ]);
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(2); // dismissed hidden
    // the TTL index (not read state) is what removes all three eventually
    expect((await Notification.collection.indexes()).some((i) => i.expireAfterSeconds === 90 * 86400)).toBe(true);
  });
});

describe('email delivery resilience', () => {
  const roleChange = () =>
    give('empA', { type: 'person.role_changed', target: null, resourceId: users.empA._id, params: { role: 'manager' } });

  it('a Redis failure while queueing never loses the notification; the sweeper re-queues it', async () => {
    const client = createRedisClient();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const rPush = jest.spyOn(client, 'rPush').mockRejectedValueOnce(new Error('redis down'));

    const { created } = await roleChange();
    rPush.mockRestore();
    expect(created).toHaveLength(1);

    // In-app copy is there and email is merely pending.
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(1);
    expect((await Notification.findOne()).email.status).toBe('pending');
    expect(await client.lLen('test:email:queue')).toBe(0);

    const swept = await sweepPendingEmails({ now: Date.now() + 3 * 60 * 1000 });
    expect(swept).toEqual({ checked: 1, requeued: 1 });
    expect((await Notification.findOne()).email.status).toBe('queued');

    await queue.processOnce();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: users.empA.email }));
    expect(await Notification.findOne()).toMatchObject({ email: expect.objectContaining({ status: 'sent' }) });
    errorSpy.mockRestore();
  });

  it('running the sweeper again does not email twice', async () => {
    await roleChange();
    await queue.processOnce(); // delivered
    await Notification.updateOne({}, { 'email.status': 'pending' }); // simulate a lost status update
    await sweepPendingEmails({ now: Date.now() + 3 * 60 * 1000 });
    await queue.processOnce();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1); // jobId dedupe
  });

  it('a permanently failing email leaves the in-app notification intact and records the failure', async () => {
    emailService.sendEmail.mockRejectedValue(new Error('mailbox full'));
    await roleChange();
    let now = Date.now();
    for (let i = 0; i <= queue.MAX_RETRIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await queue.processOnce({ now });
      now += 3 * 60 * 1000;
    }

    const row = await Notification.findOne();
    expect(row.email.status).toBe('failed');
    expect(row.email.lastError).toBe('mailbox full');
    expect(row.inApp).toBe(true);
    const list = await as('empA').get('/api/v1/notifications').expect(200);
    expect(list.body.notifications).toHaveLength(1);
    expect(list.body.unreadCount).toBe(1);
    expect(await createRedisClient().lLen('test:email:dead')).toBe(1);
  });

  it('gives up sweeping after repeated failures instead of retrying forever', async () => {
    await roleChange();
    await createRedisClient().del('test:email:queue');
    await Notification.updateOne({}, { 'email.status': 'pending', 'email.attempts': 5 });
    await sweepPendingEmails({ now: Date.now() + 3 * 60 * 1000 });
    expect((await Notification.findOne()).email.status).toBe('failed');
  });

  it('does not email people who were blocked after the notification was created', async () => {
    const client = createRedisClient();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(client, 'rPush').mockRejectedValueOnce(new Error('redis down'));
    await roleChange();
    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    await sweepPendingEmails({ now: Date.now() + 3 * 60 * 1000 });
    expect(await client.lLen('test:email:queue')).toBe(0);
    expect((await Notification.findOne()).email.status).toBe('none');
  });

  it('real-time publish failures do not affect persistence', async () => {
    const client = createRedisClient();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(client, 'publish').mockRejectedValue(new Error('pubsub down'));
    const { created } = await give('empA');
    expect(created).toHaveLength(1);
    expect((await as('empA').get('/api/v1/notifications').expect(200)).body.notifications).toHaveLength(1);
  });
});
