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
const AuditLog = require('../../src/models/AuditLog');
const Meeting = require('../../src/models/Meeting');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const hub = require('../../src/services/notificationHub');
const { clearAnalyticsCache } = require('../../src/services/analytics');
const { localDateOf, parseDateOnly } = require('../../src/utils/timezone');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const KEYS = ['superadmin', 'admin', 'admin2', 'hr', 'manager', 'manager2', 'empA', 'empB', 'empC', 'guest', 'adminB'];
const api = (path = '') => `/api/v1/analytics${path}`;
const DAY = 86400000;
const todayMs = parseDateOnly(localDateOf(Date.now(), 'Asia/Kolkata')); // default timezone is IST
const dueIn = (days) => new Date(todayMs + days * DAY);

let orgA; let orgB; let eng; let design; let p1; let p2;
const task = (project, title, extra = {}) =>
  Task.create({ organization: orgA._id, project: project._id, title, owner: users.admin._id, createdBy: users.admin._id, ...extra });
const names = (body) => JSON.stringify(body);

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all(KEYS.map(makeAgent));
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
  clearAnalyticsCache();
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid(), plan: 'pro' });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'admin2', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'manager2', ROLES.MANAGER);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'empC', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });

  eng = await Team.create({ organization: orgA._id, name: 'Engineering', lead: users.manager._id, members: [users.manager._id, users.empA._id, users.empB._id] });
  design = await Team.create({ organization: orgA._id, name: 'Design', lead: users.manager2._id, members: [users.manager2._id, users.empC._id] });
  const project = (name, owner, visibility, members, team) =>
    Project.create({ organization: orgA._id, owner: owner._id, createdBy: owner._id, name, slug: name.toLowerCase().replace(/\W/g, '-'), visibility, team: team?._id, members: members.map((u) => ({ user: u._id, role: 'Contributor' })) });
  p1 = await project('Apollo', users.admin, 'Organization', [users.manager, users.empA, users.empB], eng);
  p2 = await project('Secret Gemini', users.admin, 'Private', [users.empC, users.manager2], design);

  await task(p1, 'Apollo overdue', { assignees: [users.empA._id], status: 'Todo', dueDate: dueIn(-3) });
  await task(p1, 'Apollo done', { assignees: [users.empA._id], status: 'Completed', completedAt: new Date(), dueDate: dueIn(1) });
  await task(p1, 'Apollo in progress', { assignees: [users.empB._id], status: 'In Progress', dueDate: dueIn(5), priority: 'High' });
  await task(p1, 'Apollo PRIVATE budget', { assignees: [users.empB._id], status: 'Todo', visibility: 'Private', dueDate: dueIn(2) });
  await task(p2, 'Gemini overdue', { assignees: [users.empC._id], status: 'Todo', dueDate: dueIn(-1) });
  await task(p2, 'Gemini done', { assignees: [users.manager2._id], status: 'Completed', completedAt: new Date() });
});

afterEach(clearTestDb);

describe('who may open analytics', () => {
  const domain = ['overview', 'tasks', 'projects', 'people', 'teams', 'meetings', 'assets', 'me', 'reports/tasks', 'reports/tasks/export'];

  it('guests get nothing, from any endpoint', async () => {
    for (const path of domain) {
      // eslint-disable-next-line no-await-in-loop
      expect((await as('guest').get(api(`/${path}`))).status).toBe(403);
    }
    await as('guest').get(api('/platform')).expect(403);
  });

  it('employees get only their personal analytics', async () => {
    await as('empA').get(api('/me')).expect(200);
    await as('empA').get(api('/overview')).expect(200);
    for (const path of ['tasks', 'projects', 'people', 'teams', 'meetings', 'assets', 'reports/people', 'reports/people/export']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await as('empA').get(api(`/${path}`))).status).toBe(403);
    }
    await as('empA').get(api('/platform')).expect(403);
    expect((await as('empA').get(api('/overview')).expect(200)).body.mode).toBe('personal');
  });

  it('super-admin sees platform analytics only, never tenant analytics', async () => {
    await as('superadmin').get(api('/platform')).expect(200);
    for (const path of ['overview', 'tasks', 'me', 'people', 'reports/tasks']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await as('superadmin').get(api(`/${path}`))).status).toBe(403);
    }
  });

  it('requires authentication, and refuses organization-blocked users', async () => {
    await require('supertest')(createHarness().app).get(api('/overview')).expect(401);
    await require('../../src/models/User').updateOne({ _id: users.manager._id }, { orgBlocked: true });
    expect((await as('manager').get(api('/overview')).expect(403)).body.code).toBe('ORG_BLOCKED');
  });
});

describe('org-admin and admin', () => {
  it('see identical organization-wide task analytics', async () => {
    const a = (await as('admin').get(api('/tasks')).expect(200)).body;
    const b = (await as('admin2').get(api('/tasks')).expect(200)).body;
    expect(b.kpis).toEqual(a.kpis);
    expect(a.scope.kind).toBe('organization');
    expect(a.kpis).toMatchObject({ total: 6, open: 4, completed: 2, overdue: 2, completionRate: 33.3 });
    expect(a.breakdowns.byProject.map((p) => p.name).sort()).toEqual(['Apollo', 'Secret Gemini']);
    expect(a.kpis.completedWithoutDate).toBe(0);
  });

  it('count overdue by date-only deadlines: due today is not overdue, due yesterday is', async () => {
    await task(p1, 'Due today', { assignees: [users.empA._id], dueDate: dueIn(0) });
    await task(p1, 'Due yesterday', { assignees: [users.empA._id], dueDate: dueIn(-1) });
    expect((await as('admin').get(api('/tasks')).expect(200)).body.kpis.overdue).toBe(3); // the 2 seeded + yesterday, not today
  });

  it('report completed tasks that have no recorded completion date instead of inventing one', async () => {
    await task(p1, 'Legacy done', { assignees: [users.empA._id], status: 'Completed' });
    const body = (await as('admin').get(api('/tasks')).expect(200)).body;
    expect(body.kpis.completedWithoutDate).toBe(1);
    expect(body.kpis.completed).toBe(3);
    expect(body.kpis.completedInRange).toBe(2); // the legacy one is not placed anywhere in time
    expect(body.notes.join(' ')).toMatch(/before completion dates were tracked/);
  });

  it('see people, teams, projects, meetings and assets analytics', async () => {
    const people = (await as('admin').get(api('/people')).expect(200)).body;
    expect(people.kpis.members).toBe(9); // everyone in the organization except the platform account
    const empA = (await as('admin').get(api('/reports/people?limit=100')).expect(200)).body.rows.find((r) => r.person.startsWith('EmpA'));
    expect(empA).toMatchObject({ assigned: 2, open: 1, overdue: 1, completed: 1, teams: 'Engineering' });
    const teams = (await as('admin').get(api('/teams')).expect(200)).body;
    expect(teams.breakdowns.byTeam.find((t) => t.name === 'Engineering')).toMatchObject({ members: 3, open: 3, overdue: 1, projects: 1 });
    expect((await as('admin').get(api('/projects')).expect(200)).body.kpis).toMatchObject({ total: 2 });
    await as('admin').get(api('/meetings')).expect(200);
    expect((await as('admin').get(api('/assets')).expect(200)).body.kpis.total).toBe(0);
  });
});

describe('HR: privacy-safe aggregates', () => {
  it('sees organization-wide counts that match the admin view', async () => {
    const hr = (await as('hr').get(api('/tasks')).expect(200)).body;
    const admin = (await as('admin').get(api('/tasks')).expect(200)).body;
    expect(hr.scope).toMatchObject({ kind: 'aggregate', details: false });
    expect(hr.kpis).toEqual(admin.kpis);
  });

  it('never receives task titles, project names or private task content', async () => {
    for (const path of ['overview', 'tasks', 'projects', 'people', 'teams', 'meetings', 'reports/tasks?limit=100', 'reports/people?limit=100', 'reports/teams?limit=100']) {
      // eslint-disable-next-line no-await-in-loop
      const body = names((await as('hr').get(api(`/${path}`)).expect(200)).body);
      expect(body).not.toMatch(/Apollo|Gemini|PRIVATE|budget/i);
    }
    expect((await as('hr').get(api('/tasks')).expect(200)).body.breakdowns.byProject).toBeUndefined();
  });

  it('cannot reach project-level views, filters or reports, and cannot use filters to retrieve records', async () => {
    await as('hr').get(api(`/tasks?projectId=${p2._id}`)).expect(403);
    await as('hr').get(api(`/projects?projectId=${p1._id}`)).expect(403);
    await as('hr').get(api('/reports/projects')).expect(403);
    await as('hr').get(api('/reports/projects/export')).expect(403);
    await as('hr').get(api('/reports/meetings')).expect(403);
    expect((await as('hr').get(api('/projects')).expect(200)).body.kpis.total).toBe(2); // counts only
  });

  it('keeps HR\'s ordinary permissions unchanged: no direct access to private projects or tasks', async () => {
    await as('hr').get(`/api/v1/projects/${p2._id}`).expect(403);
    await as('hr').get(`/api/v1/projects/${p2._id}/tasks`).expect(403);
  });

  it('gets per-person workload counts (no scores) for the people directory', async () => {
    const rows = (await as('hr').get(api('/reports/people?limit=100')).expect(200)).body.rows;
    expect(rows.find((r) => r.person.startsWith('EmpB'))).toMatchObject({ assigned: 2, open: 2 }); // includes the private task, counted only
    expect(Object.keys(rows[0]).sort()).toEqual(['assigned', 'completed', 'id', 'meetingsAttended', 'meetingsInvited', 'open', 'overdue', 'person', 'role', 'teams']);
  });
});

describe('manager: led teams, within what they can already see', () => {
  it('counts only visible tasks of the people they lead', async () => {
    const body = (await as('manager').get(api('/tasks')).expect(200)).body;
    expect(body.scope.kind).toBe('team');
    // empA ×2 and empB's public task. empB's PRIVATE task and everything in the private project are excluded.
    expect(body.kpis).toMatchObject({ total: 3, completed: 1, overdue: 1, open: 2 });
    expect(names(body)).not.toMatch(/PRIVATE|Gemini/);
    const people = (await as('manager').get(api('/reports/people?limit=100')).expect(200)).body.rows.map((r) => r.person.split(' ')[0]).sort();
    expect(people).toEqual(['EmpA', 'EmpB', 'Manager']);
  });

  it('cannot see other teams, other people or projects they cannot access — filters are 404', async () => {
    await as('manager').get(api(`/tasks?teamId=${design._id}`)).expect(404);
    await as('manager').get(api(`/people?userId=${users.empC._id}`)).expect(404);
    await as('manager').get(api(`/tasks?projectId=${p2._id}`)).expect(404);
    expect(names((await as('manager').get(api('/teams')).expect(200)).body)).not.toMatch(/Design/);
    expect((await as('manager').get(api(`/tasks?teamId=${eng._id}`)).expect(200)).body.kpis.total).toBe(3);
  });

  it('a manager who leads no team sees only themselves', async () => {
    await Team.updateOne({ _id: eng._id }, { lead: users.manager2._id });
    const rows = (await as('manager').get(api('/reports/people?limit=100')).expect(200)).body.rows;
    expect(rows).toHaveLength(1);
    expect((await as('manager').get(api('/teams')).expect(200)).body.kpis.teams).toBe(0);
  });

  it('also gets personal analytics', async () => {
    await task(p1, 'Manager own', { assignees: [users.manager._id], dueDate: dueIn(2) });
    const me = (await as('manager').get(api('/me')).expect(200)).body;
    expect(me.kpis.assigned).toBe(1);
    expect(names(me)).not.toMatch(/EmpA/);
  });
});

describe('employee: only their own data', () => {
  it('shows own tasks, deadlines, projects and nothing about other people', async () => {
    const me = (await as('empA').get(api('/me')).expect(200)).body;
    expect(me.kpis).toMatchObject({ assigned: 2, completed: 1, overdue: 1, open: 1, projects: 1 });
    expect(me.lists.overdueTasks.map((t) => t.title)).toEqual(['Apollo overdue']);
    expect(names(me)).not.toMatch(/Gemini|PRIVATE|EmpB|EmpC/);
    // Passing someone else's id changes nothing: the endpoint is always "me".
    expect((await as('empA').get(api(`/me?userId=${users.empB._id}`)).expect(200)).body.kpis.assigned).toBe(2);
  });

  it('cannot use filters on the overview to look at someone else', async () => {
    await as('empA').get(api(`/overview?userId=${users.empB._id}`)).expect(403);
    await as('empA').get(api(`/overview?teamId=${eng._id}`)).expect(403);
  });
});

describe('organization isolation', () => {
  it('another organization sees none of this data and cannot probe it with ids', async () => {
    const b = (await as('adminB').get(api('/tasks')).expect(200)).body;
    expect(b.kpis.total).toBe(0);
    await as('adminB').get(api(`/tasks?teamId=${eng._id}`)).expect(404);
    await as('adminB').get(api(`/tasks?projectId=${p1._id}`)).expect(404);
    await as('adminB').get(api(`/people?userId=${users.empA._id}`)).expect(404);
    expect((await as('adminB').get(api('/reports/people')).expect(200)).body.rows.map((r) => r.person)).toEqual(['AdminB Tester']);
  });
});

describe('meetings', () => {
  it('counts statuses, participation and attendance, and gives HR counts without topics', async () => {
    const start = new Date();
    await Meeting.create({ organization: orgA._id, project: p1._id, topic: 'Roadmap sync', type: 'Scheduled', status: 'Ended', startTime: start, endTime: new Date(start.getTime() + 3600000), host: users.admin._id, createdBy: users.admin._id,
      participants: [{ user: users.empA._id, status: 'Accepted', joinedAt: start }, { user: users.empB._id, status: 'Declined' }] });
    await Meeting.create({ organization: orgA._id, project: p1._id, topic: 'Cancelled one', type: 'Scheduled', status: 'Cancelled', startTime: start, host: users.admin._id, createdBy: users.admin._id, participants: [] });

    const admin = (await as('admin').get(api('/meetings')).expect(200)).body;
    expect(admin.kpis).toMatchObject({ total: 2, ended: 1, cancelled: 1, invitations: 2, accepted: 1, declined: 1, attended: 1, attendanceRate: 50, avgPlannedMinutes: 60 });
    expect(admin.kpis.avgActualMinutes).toBeNull(); // no start/end audit records: not invented
    expect((await as('admin').get(api('/reports/meetings')).expect(200)).body.rows.map((r) => r.topic).sort()).toEqual(['Cancelled one', 'Roadmap sync']);

    const hr = (await as('hr').get(api('/meetings')).expect(200)).body;
    expect(hr.kpis.total).toBe(2);
    expect(names(hr)).not.toMatch(/Roadmap/);

    // A manager only sees meetings involving their people.
    expect((await as('manager').get(api('/meetings')).expect(200)).body.kpis.total).toBe(1);
    expect((await as('empA').get(api('/me')).expect(200)).body.kpis).toMatchObject({ meetings: 1, meetingsAttended: 1 });
    expect((await as('empC').get(api('/me')).expect(200)).body.kpis.meetings).toBe(0);
  });
});

describe('assets', () => {
  it('reuses role-scoped asset data, adds trends, and keeps money to people who may see it', async () => {
    const category = (await as('admin').get('/api/v1/assets/categories').expect(200)).body.categories[0].id;
    const created = (await as('admin').post('/api/v1/assets').send({ name: 'Laptop', categoryId: category, purchase: { cost: 1000, currency: 'INR' } }).expect(201)).body.asset;
    await as('admin').post(`/api/v1/assets/${created.id}/assign`).send({ userId: String(users.empA._id) }).expect(201);

    const admin = (await as('admin').get(api('/assets')).expect(200)).body;
    expect(admin.kpis).toMatchObject({ total: 1, assigned: 1, available: 0, utilization: 100 });
    expect(admin.series.assignments.reduce((a, d) => a + d.assigned, 0)).toBe(1);
    expect(admin.breakdowns.purchaseValue).toEqual([{ currency: 'INR', total: 1000, assets: 1 }]);
    expect(admin.breakdowns.maintenanceSpend).toEqual([]);

    const manager = (await as('manager').get(api('/assets')).expect(200)).body;
    expect(manager.kpis.total).toBe(1); // the held asset belongs to someone they lead
    expect(manager.breakdowns.purchaseValue).toBeNull();
    expect(manager.breakdowns.maintenanceSpend).toBeNull();
    expect((await as('manager2').get(api('/assets')).expect(200)).body.kpis.total).toBe(0);
    await as('empA').get(api('/assets')).expect(403);
    expect((await as('empA').get(api('/me')).expect(200)).body.lists.assets.map((a) => a.name)).toEqual(['Laptop']);
    expect((await as('empB').get(api('/me')).expect(200)).body.lists.assets).toEqual([]);
  });
});

describe('reports share the overview calculations', () => {
  it('report rows, overview and CSV agree', async () => {
    const overview = (await as('admin').get(api('/projects')).expect(200)).body;
    const report = (await as('admin').get(api('/reports/projects')).expect(200)).body;
    expect(report.rows).toHaveLength(overview.kpis.total);
    expect(report.rows.find((r) => r.project === 'Apollo')).toMatchObject({ tasks: 4, completed: 1, overdue: 1 });

    const csv = await as('admin').get(api('/reports/projects/export')).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="projects-report-/);
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toBe('Project,Status,Priority,Team,Owner,Due date,Tasks,Open,Completed,Overdue,Progress %');
    expect(lines).toHaveLength(1 + overview.kpis.total);
  });

  it('paginates and neutralises spreadsheet formulas in exports', async () => {
    for (let i = 0; i < 4; i += 1) await Project.create({ organization: orgA._id, owner: users.admin._id, createdBy: users.admin._id, name: `=SUM(A${i})`, slug: `p-${i}`, visibility: 'Organization' });
    const page = (await as('admin').get(api('/reports/projects?limit=2&page=2')).expect(200)).body;
    expect(page.pagination).toEqual({ page: 2, limit: 2, total: 6, pages: 3 });
    expect(page.rows).toHaveLength(2);
    expect((await as('admin').get(api('/reports/projects/export')).expect(200)).text).toContain("'=SUM(A0)");
    await as('admin').get(api('/reports/projects?limit=500')).expect(400);
    await as('admin').get(api('/reports/payroll')).expect(404);
  });

  it('validates the date range', async () => {
    await as('admin').get(api('/tasks?from=2026-05-02&to=2026-05-01')).expect(400);
    expect((await as('admin').get(api('/tasks?from=2024-01-01&to=2026-01-01')).expect(400)).body.code).toBe('RANGE_TOO_LARGE');
    await as('admin').get(api('/tasks?from=nope')).expect(400);
    await as('admin').get(api('/tasks?organization=x')).expect(400);
    const ok = (await as('admin').get(api('/tasks?from=2026-01-01&to=2026-06-30')).expect(200)).body;
    expect(ok.range).toMatchObject({ granularity: 'month', timeZone: 'Asia/Kolkata' });
    expect(ok.series.createdVsCompleted).toHaveLength(6);
  });

  it('builds the completion trend from recorded completion dates', async () => {
    const series = (await as('admin').get(api('/tasks')).expect(200)).body.series.createdVsCompleted;
    expect(series).toHaveLength(30);
    expect(series.reduce((a, d) => a + d.completed, 0)).toBe(2);
    expect(series.reduce((a, d) => a + d.created, 0)).toBe(6);
  });

  it('builds projects completed over time from status-change records', async () => {
    await AuditLog.create({ organization: orgA._id, user: users.admin._id, action: 'project.status_changed', entityType: 'project', entityId: String(p1._id), metadata: { from: 'Active', to: 'Completed' } });
    await AuditLog.create({ organization: orgB._id, user: users.adminB._id, action: 'project.status_changed', entityType: 'project', entityId: String(oid()), metadata: { from: 'Active', to: 'Completed' } });
    const body = (await as('admin').get(api('/projects')).expect(200)).body;
    expect(body.kpis.completedInRange).toBe(1); // the other organization's event is not counted
    expect(body.notes.join(' ')).toMatch(/audit log/);
  });
});

describe('platform analytics (super-admin)', () => {
  it('reports organization and user counts and login activity, with no tenant content', async () => {
    await AuditLog.create({ organization: orgA._id, user: users.empA._id, action: 'auth.login_succeeded', entityType: 'auth' });
    await AuditLog.create({ organization: orgA._id, user: users.empA._id, action: 'auth.login_succeeded', entityType: 'auth' });
    await AuditLog.create({ organization: orgB._id, user: users.adminB._id, action: 'auth.login_succeeded', entityType: 'auth' });
    await Organization.updateOne({ _id: orgB._id }, { isActive: false });

    const body = (await as('superadmin').get(api('/platform')).expect(200)).body;
    expect(body.kpis).toMatchObject({ organizations: 2, activeOrganizations: 1, suspendedOrganizations: 1, newOrganizations: 2, users: 10, logins: 3 });
    expect(body.breakdowns.plans.map((p) => p.key).sort()).toEqual(['free', 'pro']);
    expect(body.series.logins.reduce((a, d) => a + d.accounts, 0)).toBe(2); // distinct accounts per day
    const text = names(body);
    expect(text).not.toMatch(/Acme|Globex|Apollo|Gemini|EmpA|@/);
    await as('admin').get(api('/platform')).expect(403);
    await as('superadmin').get(api('/platform?projectId=x')).expect(400);
  });
});

describe('caching never crosses permission scopes', () => {
  const withCache = async (fn) => {
    process.env.ANALYTICS_CACHE = 'on';
    try { await fn(); } finally { process.env.ANALYTICS_CACHE = 'off'; clearAnalyticsCache(); }
  };

  it('serves a fresh result when the actor\'s team scope changes, even within the cache window', () => withCache(async () => {
    expect((await as('manager').get(api('/tasks')).expect(200)).body.kpis.total).toBe(3);
    await task(p1, 'Added later', { assignees: [users.empA._id] });
    expect((await as('manager').get(api('/tasks')).expect(200)).body.kpis.total).toBe(3); // cached for this scope
    await Team.updateOne({ _id: eng._id }, { lead: users.manager2._id }); // manager no longer leads Engineering
    expect((await as('manager').get(api('/tasks')).expect(200)).body.kpis.total).toBe(0); // new scope → new key, not the stale 3
  }));

  it('never shares results between users or roles', () => withCache(async () => {
    const admin = (await as('admin').get(api('/tasks')).expect(200)).body;
    const hr = (await as('hr').get(api('/tasks')).expect(200)).body;
    expect(admin.scope.kind).toBe('organization');
    expect(hr.scope.kind).toBe('aggregate');
    expect(admin.breakdowns.byProject).toBeDefined();
    expect(hr.breakdowns.byProject).toBeUndefined();
  }));
});
