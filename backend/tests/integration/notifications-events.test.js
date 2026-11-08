jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(),
  sendMeetingRequestDecisionEmail: jest.fn(),
}));

const mongoose = require('mongoose');
const emailService = require('../../src/services/email.service');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const Meeting = require('../../src/models/Meeting');
const Notification = require('../../src/models/Notification');
const NotificationPreference = require('../../src/models/NotificationPreference');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const queue = require('../../src/services/email-queue');
const EmailOutbox = require('../../src/models/EmailOutbox');
const { sendAccountEmail, sweepPendingEmails } = require('../../src/services/notificationEmail.service');
const { runMeetingReminders } = require('../../src/services/notificationJobs');

const { users, createUser, makeAgent, as } = createHarness();

let orgA;
let orgB;
let project;
const oid = () => new mongoose.Types.ObjectId();

const inbox = async (key, query = '') => (await as(key).get(`/api/v1/notifications${query}`).expect(200)).body.notifications;
const typesOf = async (key) => (await inbox(key)).map((n) => n.type).sort();
const count = (key, type) => Notification.countDocuments({ recipient: users[key]._id, ...(type ? { type } : {}) });

async function emailJobs() {
  const raw = await createRedisClient().lRange('test:email:queue', 0, -1);
  return raw.map((entry) => JSON.parse(entry));
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Notification.init();
  await Promise.all(['admin', 'manager', 'manager2', 'hr', 'empA', 'empB', 'empC', 'guest', 'adminB', 'empOtherOrg'].map(makeAgent));
});

afterAll(async () => {
  await hub.shutdown();
  const client = createRedisClient();
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);
  await disconnectTestDb();
  await client.quit();
});

beforeEach(async () => {
  const client = createRedisClient();
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);
  jest.clearAllMocks();

  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'manager2', ROLES.MANAGER);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'empC', ROLES.EMPLOYEE); // not in the project
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empOtherOrg', ROLES.EMPLOYEE);

  project = await Project.create({
    organization: orgA._id, owner: users.manager._id, createdBy: users.manager._id, name: 'Apollo', slug: 'apollo',
    visibility: 'Private',
    members: [
      { user: users.manager._id, role: 'Owner' },
      { user: users.empA._id, role: 'Contributor' },
      { user: users.empB._id, role: 'Contributor' },
    ],
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

const taskPath = (suffix = '') => `/api/v1/projects/${project._id}/tasks${suffix}`;
const createTask = (body = {}) =>
  as('manager').post(taskPath()).send({ title: 'Fix login', assignees: [users.empA._id.toString()], approvers: [users.manager._id.toString()], ...body });

describe('tasks', () => {
  it('notifies new assignees (not the actor), links to the task, and emails the assignment', async () => {
    const res = await createTask({ assignees: [users.empA._id.toString(), users.manager._id.toString()] }).expect(201);
    const taskId = res.body.task.id;

    expect(await typesOf('empA')).toEqual(['task.assigned']);
    expect(await count('manager')).toBe(0); // assigned themselves: no self-notification
    expect(await count('empB')).toBe(0);
    const [n] = await inbox('empA');
    expect(n).toMatchObject({ title: 'Task assigned', link: `/dashboard/projects/${project._id}/tasks/${taskId}`, available: true });
    expect(n.message).toBe('Manager Tester assigned you “Fix login” in Apollo.');
    expect(n.actor.fullName).toBe('Manager Tester');

    const jobs = await emailJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ to: users.empA.email });
    expect(jobs[0].html).toContain(`/dashboard/projects/${project._id}/tasks/${taskId}`);
  });

  it('notifies on reassignment, and treats assign → unassign → assign again as genuinely new events', async () => {
    const taskId = (await createTask().expect(201)).body.task.id;
    const patch = (assignees) => as('manager').patch(taskPath(`/${taskId}`)).send({ assignees }).expect(200);

    await patch([users.empB._id.toString()]); // A out, B in
    expect(await typesOf('empA')).toEqual(['task.assigned', 'task.unassigned']);
    expect(await typesOf('empB')).toEqual(['task.assigned']);
    expect((await inbox('empA')).find((n) => n.type === 'task.unassigned').link).toBeNull();

    await patch([users.empB._id.toString()]); // no change: nothing new
    expect(await count('empB')).toBe(1);

    await patch([users.empA._id.toString()]); // A back in: a NEW assignment, must not be deduped away
    expect(await count('empA', 'task.assigned')).toBe(2);
  });

  it('only interrupts for meaningful status changes', async () => {
    const taskId = (await createTask().expect(201)).body.task.id;
    await as('manager').patch(taskPath(`/${taskId}`)).send({ status: 'In Progress' }).expect(200);
    await as('manager').patch(taskPath(`/${taskId}`)).send({ title: 'Renamed', priority: 'High' }).expect(200);
    expect(await typesOf('empA')).toEqual(['task.assigned']); // no noise for minor edits

    await as('manager').patch(taskPath(`/${taskId}`)).send({ status: 'Completed' }).expect(200);
    expect(await typesOf('empA')).toEqual(['task.assigned', 'task.status_changed']);
    expect((await inbox('empA')).find((n) => n.type === 'task.status_changed').message).toContain('Completed');
  });

  it('runs the submit → review loop: reviewers, then submitter, with the right emails', async () => {
    const taskId = (await createTask().expect(201)).body.task.id;
    await as('manager').patch(taskPath(`/${taskId}`)).send({ status: 'In Progress' }).expect(200);

    await as('empA').post(taskPath(`/${taskId}/submit`)).send({ description: 'Ready' }).expect(200);
    expect(await typesOf('manager')).toEqual(['task.submitted']);
    expect(await count('empB')).toBe(0); // a project member who isn't a reviewer is not told

    await as('manager').post(taskPath(`/${taskId}/review`)).send({ action: 'Changes Requested', remarks: 'tests' }).expect(200);
    expect(await count('empA', 'task.changes_requested')).toBe(1);

    await as('empA').post(taskPath(`/${taskId}/submit`)).send({ description: 'Round two' }).expect(200);
    await as('manager').post(taskPath(`/${taskId}/review`)).send({ action: 'Approved' }).expect(200);
    await as('empA').post(taskPath(`/${taskId}/submit`)).send({ description: 'Round three' }).expect(200);
    await as('manager').post(taskPath(`/${taskId}/review`)).send({ action: 'Rejected' }).expect(200);

    expect(await typesOf('empA')).toEqual(['task.approved', 'task.assigned', 'task.changes_requested', 'task.rejected']);
    expect(await count('manager', 'task.submitted')).toBe(3); // three distinct submissions
    const subjects = (await emailJobs()).map((job) => job.subject);
    expect(subjects.some((s) => /Changes requested/.test(s))).toBe(true);
    expect(subjects.some((s) => /rejected/i.test(s))).toBe(true);
    expect(subjects.some((s) => /approved/i.test(s))).toBe(false); // approvals stay in-app
  });

  it('a notification failure never fails the task operation', async () => {
    jest.spyOn(Notification, 'findOneAndUpdate').mockRejectedValue(new Error('mongo blip'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createTask().expect(201);
    expect(res.body.task.title).toBe('Fix login');
    expect(errorSpy).toHaveBeenCalled();
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe('projects', () => {
  const members = (suffix = '') => `/api/v1/projects/${project._id}/members${suffix}`;

  it('added → role changed → removed (the removal never links)', async () => {
    await as('manager').post(members()).send({ userId: users.empC._id.toString(), role: 'Viewer' }).expect(201);
    // While they're a member the link works.
    expect((await inbox('empC'))[0]).toMatchObject({ link: `/dashboard/projects/${project._id}`, available: true });

    await as('manager').patch(members(`/${users.empC._id}`)).send({ role: 'Contributor' }).expect(200);
    await as('manager').delete(members(`/${users.empC._id}`)).expect(200);

    expect(await typesOf('empC')).toEqual(['project.member_added', 'project.member_removed', 'project.role_changed']);
    const list = await inbox('empC');
    // Once removed, the removal itself never had a link, and earlier links stop working.
    expect(list.find((n) => n.type === 'project.member_removed').link).toBeNull();
    list.filter((n) => n.type !== 'project.member_removed').forEach((n) => {
      expect(n).toMatchObject({ link: null, available: false, message: 'You no longer have access to this item.' });
    });
  });

  it('ownership transfer notifies both the new and the previous owner', async () => {
    await as('admin').post(`/api/v1/projects/${project._id}/transfer-ownership`).send({ newOwnerId: users.manager2._id.toString() }).expect(200);
    expect(await typesOf('manager2')).toEqual(['project.ownership_received']);
    expect(await typesOf('manager')).toEqual(['project.ownership_removed']);
    expect((await inbox('manager'))[0].message).toContain('Manager2 Tester');
  });

  it('archiving and deleting tell the project\'s members, not outsiders', async () => {
    await as('manager').post(`/api/v1/projects/${project._id}/archive`).expect(200);
    expect(await typesOf('empA')).toEqual(['project.archived']);
    expect(await typesOf('empB')).toEqual(['project.archived']);
    expect(await count('empC')).toBe(0);
    expect(await count('manager')).toBe(0); // the actor

    await as('manager').delete(`/api/v1/projects/${project._id}`).expect(200);
    expect(await count('empA', 'project.deleted')).toBe(1);
    expect((await inbox('empA')).find((n) => n.type === 'project.deleted').link).toBeNull();
  });
});

describe('meetings', () => {
  const inMinutes = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();
  const meetingPath = (suffix = '') => `/api/v1/projects/${project._id}/meetings${suffix}`;
  const schedule = (body = {}) =>
    as('manager').post(meetingPath()).send({ topic: 'Sprint planning', startTime: inMinutes(120), endTime: inMinutes(180), ...body });

  it('invites every project member in-app and by email, keeping the existing invitation wording', async () => {
    const res = await schedule().expect(201);
    const meetingId = res.body.meeting.id;

    expect(await typesOf('empA')).toEqual(['meeting.invited']);
    expect(await typesOf('empB')).toEqual(['meeting.invited']);
    expect(await count('empC')).toBe(0); // not a project member
    expect(await count('manager')).toBe(0); // the host
    expect((await inbox('empA'))[0].link).toBe(`/dashboard/projects/${project._id}/meetings/${meetingId}`);

    const jobs = await emailJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].subject).toBe('Meeting invite: Sprint planning');
    expect(jobs[0].text).toMatch(/^You've been invited to "Sprint planning" on the Apollo project, scheduled for .+ Join here: http/);
  });

  it('respects a user who turned meeting emails off (in-app only)', async () => {
    await NotificationPreference.create({ user: users.empA._id, organization: orgA._id, categories: { meeting: { email: false } } });
    await schedule().expect(201);
    expect(await count('empA', 'meeting.invited')).toBe(1);
    expect((await emailJobs()).map((j) => j.to)).toEqual([users.empB.email]);
  });

  it('tells participants about meaningful updates only, and about cancellation', async () => {
    const meetingId = (await schedule().expect(201)).body.meeting.id;
    await as('manager').patch(meetingPath(`/${meetingId}`)).send({ description: 'Agenda attached' }).expect(200);
    expect(await count('empA', 'meeting.updated')).toBe(0); // a description tweak isn't worth a ping

    await as('manager').patch(meetingPath(`/${meetingId}`)).send({ startTime: inMinutes(200), endTime: inMinutes(260) }).expect(200);
    await as('manager').patch(meetingPath(`/${meetingId}`)).send({ topic: 'Sprint planning v2' }).expect(200);
    expect(await count('empA', 'meeting.updated')).toBe(2);

    await as('manager').post(meetingPath(`/${meetingId}/cancel`)).expect(200);
    expect(await typesOf('empA')).toEqual(['meeting.cancelled', 'meeting.invited', 'meeting.updated', 'meeting.updated']);
    expect((await emailJobs()).some((job) => /cancelled/i.test(job.subject) || /cancelled/i.test(job.text))).toBe(true);
  });

  it('removing a participant notifies them and adding one invites them', async () => {
    const meetingId = (await schedule().expect(201)).body.meeting.id;
    await as('manager').delete(meetingPath(`/${meetingId}/participants/${users.empB._id}`)).expect(200);
    expect(await typesOf('empB')).toEqual(['meeting.invited', 'meeting.removed']);

    await as('manager').post(meetingPath(`/${meetingId}/participants`)).send({ participants: [users.empB._id.toString()] }).expect(200);
    expect(await count('empB', 'meeting.invited')).toBe(2); // re-invited: a new event
  });

  it('meeting requests: deciders are told, then the requester gets the decision (same email wording)', async () => {
    const requests = `/api/v1/projects/${project._id}/meeting-requests`;
    const created = await as('empA').post(requests).send({ topic: 'Design sync', reason: 'Need alignment' }).expect(201);
    expect(await typesOf('manager')).toEqual(['meeting_request.received']);
    expect(await count('empB')).toBe(0);
    expect((await inbox('manager'))[0].link).toBe(`/dashboard/projects/${project._id}/meetings/requests`);

    await as('manager').post(`${requests}/${created.body.request.id}/approve`).send({ remarks: 'Thursday' }).expect(200);
    expect(await typesOf('empA')).toContain('meeting_request.approved');
    const decision = (await emailJobs()).find((job) => job.to === users.empA.email && /meeting request/.test(job.subject));
    expect(decision.subject).toBe('Your meeting request "Design sync" was approved');
    expect(decision.text).toBe('Your meeting request "Design sync" has been approved. Remarks: Thursday');

    const second = await as('empB').post(requests).send({ topic: 'Retro', reason: 'Because' }).expect(201);
    await as('manager').post(`${requests}/${second.body.request.id}/reject`).send({ remarks: 'Not now' }).expect(200);
    expect(await typesOf('empB')).toContain('meeting_request.rejected');
    const rejection = (await emailJobs()).find((job) => job.to === users.empB.email && /Retro/.test(job.subject));
    expect(rejection.subject).toBe('Your meeting request "Retro" was rejected');
  });

  describe('reminders', () => {
    const scheduledMeeting = (minutes, overrides = {}) =>
      Meeting.create({
        organization: orgA._id, project: project._id, topic: 'Standup', type: 'Scheduled', status: 'Scheduled',
        startTime: new Date(Date.now() + minutes * 60 * 1000), endTime: new Date(Date.now() + (minutes + 30) * 60 * 1000),
        host: users.manager._id, createdBy: users.manager._id,
        participants: [
          { user: users.manager._id, role: 'Host', status: 'Accepted' },
          { user: users.empA._id, role: 'Participant', status: 'Invited' },
          { user: users.empB._id, role: 'Participant', status: 'Declined' },
        ],
        ...overrides,
      });

    it('reminds active participants once per scheduled start, and again if it is rescheduled', async () => {
      const meeting = await scheduledMeeting(10);
      await runMeetingReminders();
      await runMeetingReminders(); // a second tick (or a second instance) must not repeat it

      expect(await count('empA', 'meeting.reminder')).toBe(1);
      expect(await count('manager', 'meeting.reminder')).toBe(1); // the host is reminded too
      expect(await count('empB')).toBe(0); // declined
      const [n] = await inbox('empA');
      expect(n).toMatchObject({ title: 'Meeting starting soon', link: expect.stringContaining(meeting._id.toString()) });
      expect(n.message).toMatch(/starts in about (9|10) minutes/);
      expect(await emailJobs()).toHaveLength(0); // in-app only by default

      await Meeting.updateOne({ _id: meeting._id }, { startTime: new Date(Date.now() + 5 * 60 * 1000) });
      await runMeetingReminders();
      expect(await count('empA', 'meeting.reminder')).toBe(2);
    });

    it('ignores meetings outside the window, cancelled ones and already-started ones', async () => {
      await scheduledMeeting(60);
      await scheduledMeeting(10, { status: 'Cancelled' });
      await scheduledMeeting(10, { deletedAt: new Date() });
      await scheduledMeeting(-5);
      await runMeetingReminders();
      expect(await Notification.countDocuments({ type: 'meeting.reminder' })).toBe(0);
    });
  });
});

describe('teams & people', () => {
  let team;
  beforeEach(async () => {
    team = (await as('admin').post('/api/v1/teams').send({ name: 'Engineering', lead: users.manager._id.toString() }).expect(201)).body.team;
  });

  it('added, moved between teams, removed — each told exactly what changed', async () => {
    await as('admin').post(`/api/v1/teams/${team.id}/members`).send({ userId: users.empA._id.toString() }).expect(200);
    expect(await typesOf('empA')).toEqual(['team.member_added']);
    expect((await inbox('empA'))[0].link).toBe('/dashboard/my-team');

    const design = (await as('admin').post('/api/v1/teams').send({ name: 'Design' }).expect(201)).body.team;
    await as('admin').post(`/api/v1/teams/${design.id}/members`).send({ userId: users.empA._id.toString() }).expect(200);
    expect(await typesOf('empA')).toEqual(['team.member_added', 'team.member_added', 'team.member_removed']);

    await as('admin').delete(`/api/v1/teams/${design.id}/members/${users.empA._id}`).expect(200);
    expect(await count('empA', 'team.member_removed')).toBe(2);
    expect((await inbox('empA')).filter((n) => n.type === 'team.member_removed').every((n) => n.link === null)).toBe(true);
  });

  it('manager changes notify the new and the previous manager', async () => {
    await as('admin').put(`/api/v1/teams/${team.id}/manager`).send({ userId: users.manager2._id.toString() }).expect(200);
    expect(await typesOf('manager2')).toEqual(['team.manager_assigned', 'team.member_added'].sort());
    // (The previous manager was also told they were added to the team when it was created with them as lead.)
    expect(await typesOf('manager')).toEqual(['team.manager_removed', 'team.member_added']);
  });

  it('role changes are in-app + email', async () => {
    await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ role: 'hr' }).expect(200);
    expect(await typesOf('empA')).toEqual(['person.role_changed']);
    expect((await inbox('empA'))[0].message).toBe('Admin Tester changed your role to hr.');
    expect((await emailJobs()).map((job) => job.to)).toEqual([users.empA.email]);
  });

  describe('blocked and removed people', () => {
    it('blocking: email only, no org data, no in-app notification, live streams closed', async () => {
      const closeSpy = jest.spyOn(hub, 'closeUser');
      await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: true }).expect(200);

      expect(await Notification.countDocuments({ recipient: users.empA._id })).toBe(0);
      expect(closeSpy).toHaveBeenCalledWith(users.empA._id, 'blocked');
      const jobs = await emailJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ to: users.empA.email, subject: 'Your access to Acme has been suspended' });
      expect(`${jobs[0].text} ${jobs[0].html}`).not.toMatch(/Apollo|task|document|meeting|Engineering|Admin Tester/i);
      expect(jobs[0].jobId).toMatch(/^acct:security\.access_blocked:/);
      await as('empA').get('/api/v1/notifications').expect(403);
    });

    it('blocking cannot be silenced by notification preferences', async () => {
      await NotificationPreference.create({
        user: users.empA._id, organization: orgA._id, channels: { inApp: false, email: false },
      });
      await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: true }).expect(200);
      expect(await emailJobs()).toHaveLength(1);
    });

    it('unblocking restores access and tells them in-app and by email (security category)', async () => {
      await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: true }).expect(200);
      await as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: false }).expect(200);
      expect(await typesOf('empA')).toEqual(['security.access_restored']);
      expect(await emailJobs()).toHaveLength(2); // the suspension notice + the restoration
    });

    it('removal from the organization: one generic email, no per-team noise, nothing readable afterwards', async () => {
      await as('admin').post(`/api/v1/teams/${team.id}/members`).send({ userId: users.empA._id.toString() }).expect(200);
      await emailJobsClear();
      await as('admin').delete(`/api/v1/people/${users.empA._id}`).expect(200);

      const jobs = await emailJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].subject).toBe('You were removed from Acme');
      expect(`${jobs[0].text} ${jobs[0].html}`).not.toMatch(/Apollo|Engineering|task|meeting|document/i);
      // Their sessions were revoked (tokenVersion bumped): the old token no longer works…
      await as('empA').get('/api/v1/notifications').expect(401);
      // …and even with a fresh token the earlier "added to team" notification is unreachable: no organization.
      users.empA = await User.findById(users.empA._id);
      const list = await as('empA').get('/api/v1/notifications').expect(200);
      expect(list.body.notifications).toEqual([]);
      expect(await Notification.countDocuments({ recipient: users.empA._id, type: 'team.member_removed' })).toBe(0);
    });

    it('forced password reset leaves an in-app security record and no second email', async () => {
      await as('admin').post(`/api/v1/people/${users.empA._id}/force-password-reset`).expect(200);
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      expect(await emailJobs()).toHaveLength(0);
      users.empA = await User.findById(users.empA._id); // sessions were revoked: sign in again
      expect(await typesOf('empA')).toEqual(['security.password_reset_forced']);
    });
  });
});

async function emailJobsClear() {
  await createRedisClient().del('test:email:queue');
}

describe('documents', () => {
  const pdf = (text) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj\n<<>>\nendobj\n`);
  const upload = async (key, body = {}) =>
    (await as(key).post('/api/v1/documents').attach('file', pdf('first'), { filename: 'Plan.pdf', contentType: 'application/pdf' }).field('visibility', body.visibility || 'private').expect(201)).body.document;

  it('sharing notifies the recipient (link + email); changing the permission is a new event; revoking never links', async () => {
    const doc = await upload('empA');
    await as('empA').post(`/api/v1/documents/${doc.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);

    expect(await typesOf('empB')).toEqual(['document.shared']);
    const [shared] = await inbox('empB');
    expect(shared).toMatchObject({ link: `/dashboard/documents?doc=${doc.id}`, available: true });
    expect(shared.message).toBe('EmpA Tester shared “Plan.pdf” with you as viewer.');
    expect((await emailJobs()).map((j) => j.to)).toEqual([users.empB.email]);

    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct sharedAt
    await as('empA').post(`/api/v1/documents/${doc.id}/shares`).send({ userId: users.empB._id.toString(), permission: 'editor' }).expect(200);
    expect(await count('empB', 'document.shared')).toBe(2);

    await as('empA').delete(`/api/v1/documents/${doc.id}/shares/${users.empB._id}`).expect(200);
    const list = await inbox('empB');
    expect(list.find((n) => n.type === 'document.access_revoked')).toMatchObject({ link: null, available: true });
    // The earlier "shared" notifications now point at something they can't open.
    list.filter((n) => n.type === 'document.shared').forEach((n) => expect(n).toMatchObject({ link: null, available: false }));
  });

  it('new versions notify the owner and explicit sharees, not the uploader or unrelated viewers', async () => {
    const doc = await upload('empA', { visibility: 'private' });
    await as('empA').post(`/api/v1/documents/${doc.id}/shares`).send({ userId: users.empB._id.toString(), permission: 'editor' }).expect(200);
    await as('empA').post(`/api/v1/documents/${doc.id}/shares`).send({ userId: users.empC._id.toString() }).expect(200);

    await as('empB').post(`/api/v1/documents/${doc.id}/versions`).attach('file', pdf('v2'), { filename: 'Plan.pdf', contentType: 'application/pdf' }).expect(201);
    expect(await count('empA', 'document.version_uploaded')).toBe(1); // owner
    expect(await count('empC', 'document.version_uploaded')).toBe(1); // viewer sharee
    expect(await count('empB', 'document.version_uploaded')).toBe(0); // the uploader
    expect(await count('admin')).toBe(0);

    await as('empA').post(`/api/v1/documents/${doc.id}/versions/1/restore`).expect(200);
    const restored = (await inbox('empB')).find((n) => n.type === 'document.version_uploaded');
    expect(restored.message).toContain('restored an earlier version');
  });

  it('does not leak a private document\'s existence to anyone it was not shared with', async () => {
    await upload('empA');
    for (const key of ['empB', 'empC', 'manager', 'admin', 'guest']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await count(key)).toBe(0);
    }
  });
});

describe('account-security emails survive a Redis outage (durable outbox)', () => {
  const later = () => Date.now() + 3 * 60 * 1000;
  const block = () => as('admin').patch(`/api/v1/people/${users.empA._id}`).send({ orgBlocked: true }).expect(200);

  it('persists the email BEFORE touching Redis; the sweeper delivers it once Redis is back', async () => {
    const client = createRedisClient();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const rPush = jest.spyOn(client, 'rPush').mockRejectedValue(new Error('redis down'));

    await block(); // the business operation still succeeds
    rPush.mockRestore();

    const [row] = await EmailOutbox.find().lean();
    expect(row).toMatchObject({ type: 'security.access_blocked', to: users.empA.email, status: 'pending' });
    expect(row.subject).toBe('Your access to Acme has been suspended');
    expect(await emailJobs()).toHaveLength(0); // nothing reached the queue

    expect(await sweepPendingEmails({ now: later() })).toEqual({ checked: 1, requeued: 1 });
    expect(await EmailOutbox.findOne()).toMatchObject({ status: 'queued' });

    await queue.processOnce();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: users.empA.email, subject: row.subject }));
    expect(await EmailOutbox.findOne()).toMatchObject({ status: 'sent' });
  });

  it('is idempotent: replaying the same event keeps one row, and a re-sweep does not email twice', async () => {
    await block();
    const person = await User.findById(users.empA._id);
    await sendAccountEmail({ type: 'security.access_blocked', user: person, organizationName: 'Acme', organizationId: orgA._id, occurrence: person.orgBlockedAt.getTime() });
    expect(await EmailOutbox.countDocuments()).toBe(1);

    await queue.processOnce();
    await EmailOutbox.updateOne({}, { status: 'pending' }); // pretend the status update was lost
    await sweepPendingEmails({ now: later() });
    await queue.processOnce();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1); // jobId dedupe
  });

  it('recovers an email that was queued but lost with Redis\' data (never confirmed sent)', async () => {
    await block();
    await createRedisClient().del('test:email:queue'); // Redis lost the job
    expect(await sweepPendingEmails({ now: Date.now() + 10 * 60 * 1000 })).toEqual({ checked: 0, requeued: 0 }); // too early to suspect
    expect(await sweepPendingEmails({ now: Date.now() + 40 * 60 * 1000 })).toEqual({ checked: 1, requeued: 1 });
    await queue.processOnce();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('marks the outbox row failed once the queue exhausts its retries (dead-lettered, still recorded)', async () => {
    emailService.sendEmail.mockRejectedValue(new Error('mailbox does not exist'));
    await block();
    let now = Date.now();
    for (let i = 0; i <= queue.MAX_RETRIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await queue.processOnce({ now });
      now += 3 * 60 * 1000;
    }
    expect(await EmailOutbox.findOne()).toMatchObject({ status: 'failed', lastError: 'mailbox does not exist' });
    expect(await createRedisClient().lLen('test:email:dead')).toBe(1);
  });

  it('gives up sweeping a row that can never be queued, instead of retrying forever', async () => {
    await block();
    await createRedisClient().del('test:email:queue');
    await EmailOutbox.updateOne({}, { status: 'pending', attempts: 5 });
    await sweepPendingEmails({ now: later() });
    expect(await EmailOutbox.findOne()).toMatchObject({ status: 'failed' });
  });

  it('removal from the organization is durable too, and never creates an in-app notification', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(createRedisClient(), 'rPush').mockRejectedValue(new Error('redis down'));
    await as('admin').delete(`/api/v1/people/${users.empA._id}`).expect(200);
    jest.restoreAllMocks();

    const row = await EmailOutbox.findOne({ type: 'security.removed_from_org' });
    expect(row).toMatchObject({ status: 'pending', subject: 'You were removed from Acme' });
    expect(`${row.text} ${row.html}`).not.toMatch(/Apollo|task|meeting|document|Engineering/i);
    expect(await Notification.countDocuments({ recipient: users.empA._id })).toBe(0);
  });
});

describe('cross-organization safety', () => {
  it('actions in one organization never create notifications in another', async () => {
    await createTask().expect(201);
    await as('manager').post(`/api/v1/projects/${project._id}/members`).send({ userId: users.empC._id.toString() }).expect(201);
    expect(await Notification.countDocuments({ recipient: { $in: [users.adminB._id, users.empOtherOrg._id] } })).toBe(0);
    expect(await Notification.countDocuments({ organization: orgB._id })).toBe(0);
    const all = await Notification.find().lean();
    all.forEach((n) => expect(n.organization.toString()).toBe(orgA._id.toString()));
  });

  it('a user from another org cannot be notified by naming them in a request', async () => {
    const res = await as('manager').post(`/api/v1/projects/${project._id}/members`).send({ userId: users.empOtherOrg._id.toString() });
    expect(res.status).toBe(404);
    expect(await Notification.countDocuments({ recipient: users.empOtherOrg._id })).toBe(0);
  });
});

void User; void Team;
