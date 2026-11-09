jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

const mongoose = require('mongoose');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const hub = require('../../src/services/notificationHub');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
let org;
let memberProject;
let otherProject;

const mkProject = (name, owner, members = []) =>
  Project.create({ organization: org._id, owner: owner._id, createdBy: owner._id, name, slug: name.toLowerCase(), visibility: 'Organization', members: members.map((u) => ({ user: u._id, role: 'Contributor' })) });
const mkTask = (project, title, extra = {}) =>
  Task.create({ organization: org._id, project: project._id, title, owner: users.admin._id, createdBy: users.admin._id, ...extra });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all(['admin', 'empA', 'empB'].map(makeAgent));
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
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  await createUser(org, 'admin', ROLES.ORG_ADMIN);
  await createUser(org, 'empA', ROLES.EMPLOYEE);
  await createUser(org, 'empB', ROLES.EMPLOYEE);
  memberProject = await mkProject('Alpha', users.admin, [users.empA]);
  otherProject = await mkProject('Beta', users.admin, [users.empB]);
});

afterEach(clearTestDb);

describe('GET /tasks (my tasks) visibility', () => {
  it('only shows Public tasks from projects the user belongs to, plus tasks they are personally attached to', async () => {
    await mkTask(memberProject, 'Public in my project');
    await mkTask(otherProject, 'Public in a project I am NOT in');
    await mkTask(otherProject, 'Assigned to me elsewhere', { assignees: [users.empA._id] });
    await mkTask(memberProject, 'Private in my project', { visibility: 'Private' });
    await mkTask(otherProject, 'Private elsewhere', { visibility: 'Private' });

    const titles = (await as('empA').get('/api/v1/tasks').expect(200)).body.tasks.map((t) => t.title).sort();
    expect(titles).toEqual(['Assigned to me elsewhere', 'Public in my project']);
    // empB belongs to the other project: sees ITS public tasks, none of Alpha's and no private ones.
    expect((await as('empB').get('/api/v1/tasks').expect(200)).body.tasks.map((t) => t.title).sort()).toEqual(['Assigned to me elsewhere', 'Public in a project I am NOT in']);
  });

  it('org admins still see everything they are attached to, unchanged', async () => {
    await mkTask(otherProject, 'Owned by admin');
    expect((await as('admin').get('/api/v1/tasks').expect(200)).body.tasks.map((t) => t.title)).toEqual(['Owned by admin']);
  });
});

describe('completedAt', () => {
  it('is set on every transition into Completed and cleared on reopen, without touching other records', async () => {
    const task = await mkTask(memberProject, 'Finish me');
    const untouched = await mkTask(memberProject, 'Legacy', { status: 'Completed' }); // completed before this rule: stays as-is
    const patch = (status) => as('admin').patch(`/api/v1/projects/${memberProject._id}/tasks/${task._id}`).send({ status }).expect(200);

    await patch('In Progress');
    expect((await Task.findById(task._id)).completedAt).toBeNull();
    await patch('Completed');
    const first = (await Task.findById(task._id)).completedAt;
    expect(first).toBeInstanceOf(Date);
    await patch('In Progress'); // reopened
    expect((await Task.findById(task._id)).completedAt).toBeNull();
    await patch('Completed');
    expect((await Task.findById(task._id)).completedAt.getTime()).toBeGreaterThanOrEqual(first.getTime());
    await patch('Cancelled');
    expect((await Task.findById(task._id)).completedAt).toBeNull();
    expect((await Task.findById(untouched._id)).completedAt).toBeNull(); // history is never fabricated
  });
});
