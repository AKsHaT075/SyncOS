jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/**
 * Phase 8 Step 5: what get_workload_summary returns, run directly with a fixed clock (Sat 2026-11-14 15:30 India).
 * The expected numbers are computed by an INDEPENDENT per-record oracle (canAiViewTask on every stored task, then plain JS counting),
 * never by the aggregation the tool itself uses. Gate / audit / budget behaviour is in ai-workload-summary-gate.test.js.
 */
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { SCOPE_KIND } = require('../../src/constants/analytics.constants');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const A = require('../../src/utils/aiAccess');
const { resolveScope } = require('../../src/services/analytics/scope');
const { resolveToolLimits } = require('../../src/services/ai/tools/toolLimits');
const { projectResult } = require('../../src/services/ai/tools/toolResult');
const { createGetWorkloadSummaryTool, MIN_COHORT, resultSchema } = require('../../src/services/ai/tools/getWorkloadSummary.tool');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const NOW = Date.parse('2026-11-14T10:00:00Z');
const LIMITS = resolveToolLimits();
const tool = createGetWorkloadSummaryTool({ now: () => NOW });
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const OPEN = ['Todo', 'In Progress', 'In Review'];
let orgA; let orgB; let orgC; let P; let bigTeam; let smallTeam;

async function run(actor, input = {}, { signal = new AbortController().signal, maxTimeMs = 5000, t = tool } = {}) {
  const raw = await t.run({ actor, input: t.schema.parse(input), signal, maxTimeMs });
  return projectResult(t, raw, LIMITS).result;
}

const mkTask = (project, title, over = {}) => Task.create({ organization: project.organization, project: project._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', ...over });

/** Independent oracle: every stored task is checked one by one with the per-record predicate. */
async function oracle(actor, scopeName, today = '2026-11-14') {
  const projects = new Map((await Project.find({}).lean()).map((p) => [String(p._id), p]));
  const tasks = await Task.find({}).lean();
  let people = null;
  if (scopeName === 'my_team') {
    const teams = (await Team.find({ lead: actor._id }).lean());
    const ids = new Set(teams.flatMap((tm) => [tm.lead, ...tm.members]).filter(Boolean).map(String));
    const active = (await User.find({ _id: { $in: [...ids] }, isActive: true, orgBlocked: { $ne: true } }).lean()).map((u) => String(u._id));
    people = new Set(active);
  }
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const out = { totalTasks: 0, todoTasks: 0, inProgressTasks: 0, inReviewTasks: 0, completedTasks: 0, cancelledTasks: 0, openTasks: 0, overdueTasks: 0, dueToday: 0, noDueDate: 0 };
  for (const task of tasks) {
    const project = projects.get(String(task.project));
    if (!project || !A.canAiViewTask(actor, project, task)) continue;
    const mine = task.assignees.map(String);
    if (scopeName === 'me' && !mine.includes(String(actor._id))) continue;
    if (scopeName === 'my_team' && !mine.some((id) => people.has(id))) continue;
    out.totalTasks += 1;
    const key = { Todo: 'todoTasks', 'In Progress': 'inProgressTasks', 'In Review': 'inReviewTasks', Completed: 'completedTasks', Cancelled: 'cancelledTasks' }[task.status];
    out[key] += 1;
    if (OPEN.includes(task.status)) {
      out.openTasks += 1;
      if (!task.dueDate) out.noDueDate += 1;
      else if (task.dueDate.getTime() < todayMs) out.overdueTasks += 1;
      else if (task.dueDate.getTime() === todayMs) out.dueToday += 1;
    }
  }
  return out;
}
const metricsOf = (r) => Object.fromEntries(Object.keys(r).filter((k) => /Tasks$|^dueToday$|^noDueDate$/.test(k)).map((k) => [k, r[k]]));

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
}, 30000);
afterAll(async () => {
  await hub.shutdown();
  await disconnectTestDb();
  await createRedisClient().quit();
});

beforeEach(async () => {
  await Promise.all([Organization, Project, Task, Team, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  orgC = await Organization.create({ name: 'Tiny', slug: `tiny-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'coadmin', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'bigLead', ROLES.MANAGER); // leads a team of 6 active people
  await createUser(orgA, 'smallLead', ROLES.MANAGER); // leads a team of 2 active people
  await createUser(orgA, 'lonely', ROLES.MANAGER); // leads nothing
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'member', ROLES.EMPLOYEE);
  await createUser(orgA, 'contributor', ROLES.EMPLOYEE);
  await createUser(orgA, 'projectMgr', ROLES.EMPLOYEE);
  await createUser(orgA, 'outsider', ROLES.EMPLOYEE);
  await createUser(orgA, 'blocked', ROLES.EMPLOYEE, { orgBlocked: true });
  await createUser(orgA, 'inactive', ROLES.EMPLOYEE, { isActive: false });
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgC, 'adminC', ROLES.ORG_ADMIN);
  await createUser(orgC, 'c1', ROLES.EMPLOYEE);
  await createUser(orgC, 'c2', ROLES.EMPLOYEE);
  bigTeam = await Team.create({ organization: orgA._id, name: 'Big', createdBy: oid(), lead: users.bigLead._id, members: [users.owner._id, users.member._id, users.contributor._id, users.projectMgr._id, users.outsider._id, users.blocked._id, users.inactive._id] });
  smallTeam = await Team.create({ organization: orgA._id, name: 'Small', createdBy: oid(), lead: users.smallLead._id, members: [users.member._id, users.blocked._id, users.inactive._id] });

  const roster = [{ user: users.owner._id, role: 'Owner' }, { user: users.member._id, role: 'Contributor' }, { user: users.contributor._id, role: 'Viewer' }, { user: users.projectMgr._id, role: 'Manager' }];
  const mkProject = (key, over = {}) => Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: key.toLowerCase(), name: key, visibility: 'Organization', status: 'Active', ...over });
  P = {
    apollo: await mkProject('Apollo', { members: roster }),
    skunk: await mkProject('Skunkworks', { visibility: 'Private', members: [{ user: users.member._id, role: 'Contributor' }, { user: users.projectMgr._id, role: 'Manager' }] }),
    zephyr: await mkProject('Zephyr', { members: [{ user: users.member._id, role: 'Contributor' }] }),
    archived: await mkProject('Old', { archived: true }),
    deleted: await mkProject('Gone', { deletedAt: new Date() }),
    foreign: await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'b', name: 'Apollo', visibility: 'Organization', status: 'Active' }),
  };
  await mkTask(P.apollo, 'pub-overdue', { dueDate: day('2026-11-02') });
  await mkTask(P.apollo, 'pub-today', { dueDate: day('2026-11-14'), assignees: [users.contributor._id] });
  await mkTask(P.apollo, 'pub-none', { assignees: [users.member._id, users.contributor._id] });
  await mkTask(P.apollo, 'pub-done', { dueDate: day('2026-11-01'), status: 'Completed' });
  await mkTask(P.apollo, 'pub-cancelled', { dueDate: day('2026-11-01'), status: 'Cancelled', assignees: [users.owner._id] });
  await mkTask(P.apollo, 'pub-review', { status: 'In Review', dueDate: day('2026-11-20'), assignees: [users.owner._id] });
  await mkTask(P.apollo, 'pub-progress', { status: 'In Progress', dueDate: day('2026-11-13'), assignees: [users.outsider._id] });
  await mkTask(P.apollo, 'priv-member', { visibility: 'Private', dueDate: day('2026-11-05') });
  await mkTask(P.apollo, 'priv-unattached', { visibility: 'Private', assignees: [users.contributor._id], dueDate: day('2026-11-06') });
  await mkTask(P.apollo, 'priv-approver', { visibility: 'Private', assignees: [], approvers: [users.contributor._id], dueDate: day('2026-11-07') });
  await mkTask(P.apollo, 'archived-task', { archived: true, dueDate: day('2026-11-03') });
  await mkTask(P.apollo, 'deleted-task', { deletedAt: new Date(), dueDate: day('2026-11-03') });
  await mkTask(P.skunk, 'skunk-task', { dueDate: day('2026-11-03') });
  await mkTask(P.skunk, 'skunk-other', { assignees: [users.projectMgr._id], dueDate: day('2026-11-03') });
  await mkTask(P.zephyr, 'zeph-task', { dueDate: day('2026-11-30') });
  await mkTask(P.archived, 'in-archived-project', {});
  await mkTask(P.deleted, 'in-deleted-project', {});
  await mkTask(P.foreign, 'foreign-1', { assignees: [users.adminB._id], dueDate: day('2026-11-01') });
  await mkTask(P.foreign, 'foreign-2', { assignees: [users.adminB._id] });
});

describe('arguments and schema', () => {
  test('only scope is accepted, strictly; default is me', () => {
    const ok = (i) => tool.schema.safeParse(i).success;
    expect(ok({})).toBe(true);
    for (const scope of ['me', 'my_team', 'organization']) expect(ok({ scope })).toBe(true);
    expect(ok({ scope: 'everyone' })).toBe(false);
    for (const extra of [{ organization: String(oid()) }, { user: String(oid()) }, { team: String(oid()) }, { teamId: 'x' }, { filter: {} }, { pipeline: [] }, { role: 'admin' }, { project: 'Apollo' }, { scope: 'me', limit: 5 }]) expect(ok(extra)).toBe(false);
  });

  test('the result schema is flat, fixed and has no identifying keys', () => {
    expect(Object.keys(resultSchema.shape).sort()).toEqual(['asOf', 'basis', 'cancelledTasks', 'complete', 'completedTasks', 'dueToday', 'inProgressTasks', 'inReviewTasks', 'noDueDate', 'openTasks', 'outcome', 'overdueTasks', 'peopleInScope', 'reason', 'scope', 'todoTasks', 'totalTasks'].sort());
    expect(resultSchema.safeParse({ outcome: 'ok', reason: null, scope: 'me', asOf: { date: '2026-11-14', timeZone: 'x' }, extra: 1 }).success).toBe(false);
  });
});

describe('numbers', () => {
  test('a literal anchor: member / me', async () => {
    const r = await run(users.member, { scope: 'me' });
    expect(r).toMatchObject({ outcome: 'ok', reason: null, scope: 'me', peopleInScope: null, complete: true, asOf: { date: '2026-11-14', timeZone: 'Asia/Kolkata' } });
    // pub-overdue, pub-none, pub-done, priv-member, skunk-task, zeph-task
    expect(metricsOf(r)).toEqual({ totalTasks: 6, todoTasks: 5, inProgressTasks: 0, inReviewTasks: 0, completedTasks: 1, cancelledTasks: 0, openTasks: 5, overdueTasks: 3, dueToday: 0, noDueDate: 1 });
  });

  test('every user and every scope they are allowed matches the independent per-record oracle', async () => {
    const plan = { admin: ['me', 'organization'], coadmin: ['me', 'organization'], hr: ['me', 'organization'], bigLead: ['me', 'my_team'], member: ['me'], contributor: ['me'], owner: ['me'], projectMgr: ['me'], outsider: ['me'] };
    for (const [key, scopes] of Object.entries(plan)) {
      for (const scope of scopes) {
        // eslint-disable-next-line no-await-in-loop
        const [actual, expected] = [await run(users[key], { scope }), await oracle(users[key], scope)];
        expect({ key, scope, ...metricsOf(actual) }).toEqual({ key, scope, ...expected });
        expect(actual.outcome).toBe('ok');
      }
    }
  });

  test('total = status counts; open = todo + in progress + in review; overdue / due-today / no-due are disjoint parts of open', async () => {
    const r = await run(users.admin, { scope: 'organization' });
    expect(r.totalTasks).toBe(r.todoTasks + r.inProgressTasks + r.inReviewTasks + r.completedTasks + r.cancelledTasks);
    expect(r.openTasks).toBe(r.todoTasks + r.inProgressTasks + r.inReviewTasks);
    expect(r.overdueTasks + r.dueToday + r.noDueDate).toBeLessThanOrEqual(r.openTasks);
  });

  test('due today is NOT overdue; completed and cancelled tasks are never overdue', async () => {
    const r = await run(users.contributor, { scope: 'me' });
    expect(r.dueToday).toBe(1); // pub-today
    expect(r.overdueTasks).toBe(1); // only priv-unattached (2026-11-06)
    const done = await run(users.owner, { scope: 'me' });
    expect(done.completedTasks + done.cancelledTasks).toBeGreaterThan(0);
    expect(done).toMatchObject({ overdueTasks: 0 }); // owner: cancelled + in-review(future) + the Apollo tasks assigned to others are not theirs
  });

  test('timezone: the same instant is a different "today" in a different zone, and the numbers move with it', async () => {
    await Organization.updateOne({ _id: orgA._id }, { 'settings.timezone': 'America/Los_Angeles' });
    const early = createGetWorkloadSummaryTool({ now: () => Date.parse('2026-11-14T05:00:00Z') }); // 2026-11-13 21:00 in Los Angeles
    const r = await run(users.contributor, { scope: 'me' }, { t: early });
    expect(r.asOf).toEqual({ date: '2026-11-13', timeZone: 'America/Los_Angeles' });
    expect(r.dueToday).toBe(0); // pub-today is tomorrow there
    expect(await oracle(users.contributor, 'me', '2026-11-13')).toMatchObject({ dueToday: 0, overdueTasks: r.overdueTasks });
    const late = createGetWorkloadSummaryTool({ now: () => Date.parse('2026-11-14T19:00:00Z') }); // 2026-11-15 00:30 in India
    await Organization.updateOne({ _id: orgA._id }, { 'settings.timezone': 'Asia/Kolkata' });
    const next = await run(users.contributor, { scope: 'me' }, { t: late });
    expect(next.asOf.date).toBe('2026-11-15');
    expect(next.dueToday).toBe(0);
    expect(next.overdueTasks).toBe(2); // pub-today became overdue
  });

  test('archived and deleted tasks, tasks in archived / deleted projects, and other organizations never count', async () => {
    const r = await run(users.admin, { scope: 'organization' });
    const expected = await oracle(users.admin, 'organization');
    expect(r.totalTasks).toBe(expected.totalTasks);
    const raw = await Task.countDocuments({});
    expect(r.totalTasks).toBeLessThan(raw);
    const all = await Task.find({ organization: orgA._id, archived: false, deletedAt: null }).lean();
    const inLive = all.filter((t) => String(t.project) !== String(P.archived._id) && String(t.project) !== String(P.deleted._id));
    expect(r.totalTasks).toBeLessThanOrEqual(inLive.length);
  });

  test('empty scopes: a person with no tasks gets zeros, not an error', async () => {
    const none = await run(users.bigLead, { scope: 'me' });
    expect(metricsOf(none)).toEqual({ totalTasks: 0, todoTasks: 0, inProgressTasks: 0, inReviewTasks: 0, completedTasks: 0, cancelledTasks: 0, openTasks: 0, overdueTasks: 0, dueToday: 0, noDueDate: 0 });
  });
});

describe('role to scope matrix', () => {
  const unavailable = (r, reason) => expect(r).toMatchObject({ outcome: 'not_available', reason, totalTasks: null, openTasks: null, overdueTasks: null, peopleInScope: null });

  test('employee: me only', async () => {
    expect((await run(users.member, { scope: 'me' })).outcome).toBe('ok');
    unavailable(await run(users.member, { scope: 'my_team' }), 'role_not_permitted');
    unavailable(await run(users.member, { scope: 'organization' }), 'role_not_permitted');
  });

  test('manager: me; my_team for teams actually led; never organization; a manager with no team gets a safe answer', async () => {
    expect((await run(users.bigLead, { scope: 'me' })).outcome).toBe('ok');
    const team = await run(users.bigLead, { scope: 'my_team' });
    expect(team).toMatchObject({ outcome: 'ok', scope: 'my_team', peopleInScope: 6 }); // lead + 5 active; blocked and inactive are not people
    unavailable(await run(users.bigLead, { scope: 'organization' }), 'role_not_permitted');
    unavailable(await run(users.lonely, { scope: 'my_team' }), 'no_team_led');
    unavailable(await run(users.lonely, { scope: 'organization' }), 'role_not_permitted');
  });

  test('HR: me and organization (aggregate); never my_team', async () => {
    expect((await run(users.hr, { scope: 'me' })).outcome).toBe('ok');
    unavailable(await run(users.hr, { scope: 'my_team' }), 'role_not_permitted');
    const org = await run(users.hr, { scope: 'organization' });
    expect(org.outcome).toBe('ok');
    expect(metricsOf(org)).toEqual(await oracle(users.hr, 'organization'));
  });

  test('org-admin and admin: me and organization; my_team only when they actually lead a team', async () => {
    for (const key of ['admin', 'coadmin']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await run(users[key], { scope: 'organization' })).outcome).toBe('ok');
      // eslint-disable-next-line no-await-in-loop
      unavailable(await run(users[key], { scope: 'my_team' }), 'no_team_led');
    }
    await Team.updateOne({ _id: bigTeam._id }, { lead: users.admin._id });
    expect(await run(users.admin, { scope: 'my_team' })).toMatchObject({ outcome: 'ok', peopleInScope: 6 });
  });

  test('guest and super-admin: nothing, whatever the scope', async () => {
    const superadmin = { ...users.owner.toObject(), role: ROLES.SUPER_ADMIN, organization: null };
    for (const actor of [users.guest, superadmin]) {
      for (const scope of ['me', 'my_team', 'organization']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await run(actor, { scope }).catch((e) => ({ outcome: 'error', code: e.code }));
        expect(['not_available', 'error']).toContain(r.outcome);
        if (r.outcome === 'not_available') unavailable(r, 'role_not_permitted');
      }
    }
  });

  test('role classification agrees with the analytics scope kinds (so the two cannot drift apart)', async () => {
    const expected = { admin: SCOPE_KIND.ORGANIZATION, coadmin: SCOPE_KIND.ORGANIZATION, hr: SCOPE_KIND.AGGREGATE, bigLead: SCOPE_KIND.TEAM, member: SCOPE_KIND.SELF };
    for (const [key, kind] of Object.entries(expected)) {
      // eslint-disable-next-line no-await-in-loop
      expect((await resolveScope(users[key])).kind).toBe(kind);
    }
    await expect(resolveScope(users.guest)).rejects.toMatchObject({ statusCode: 403 });
    // organization is the aggregate scope for exactly the roles analytics treats as organization / aggregate
    for (const key of ['admin', 'coadmin', 'hr']) expect((await run(users[key], { scope: 'organization' })).outcome).toBe('ok'); // eslint-disable-line no-await-in-loop
    for (const key of ['bigLead', 'member']) expect((await run(users[key], { scope: 'organization' })).outcome).toBe('not_available'); // eslint-disable-line no-await-in-loop
  });
});

describe('privacy', () => {
  test('private tasks the person cannot access through AI are excluded even from an administrator organization total', async () => {
    const admin = await run(users.admin, { scope: 'organization' });
    const everything = await Task.countDocuments({ organization: orgA._id, archived: false, deletedAt: null, project: { $nin: [P.archived._id, P.deleted._id] } });
    expect(admin.totalTasks).toBeLessThan(everything);
    // Skunkworks is Private and the admin is not a member: its two tasks are not in the total; priv-* tasks of Apollo are not either.
    const visibleToAdmin = await Task.find({ organization: orgA._id, archived: false, deletedAt: null }).lean();
    const publicApollo = visibleToAdmin.filter((t) => String(t.project) === String(P.apollo._id) && t.visibility === 'Public').length;
    const zephyr = visibleToAdmin.filter((t) => String(t.project) === String(P.zephyr._id)).length;
    expect(admin.totalTasks).toBe(publicApollo + zephyr);
  });

  test('HR sees only what AI gives HR (no administrator shortcut); its organization total is never larger than the administrator\'s', async () => {
    const [hr, admin] = [await run(users.hr, { scope: 'organization' }), await run(users.admin, { scope: 'organization' })];
    expect(hr.totalTasks).toBeLessThanOrEqual(admin.totalTasks);
    expect(metricsOf(hr)).toEqual(await oracle(users.hr, 'organization'));
  });

  test('nothing identifying leaves the tool: no ids, names, titles, descriptions, emails or per-person fields', async () => {
    const results = [];
    for (const [key, scope] of [['admin', 'organization'], ['hr', 'organization'], ['bigLead', 'my_team'], ['member', 'me']]) results.push(await run(users[key], { scope })); // eslint-disable-line no-await-in-loop
    const text = JSON.stringify(results);
    for (const secret of ['pub-', 'priv-', 'skunk', 'zeph', 'Apollo', 'Skunkworks', 'Zephyr', 'Tester', '@acme', 'Big', 'Small']) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[a-f0-9]{24}/);
    for (const key of ['member', 'owner', 'contributor', 'projectMgr', 'outsider', 'bigLead', 'smallLead']) expect(text).not.toContain(String(users[key]._id));
    for (const r of results) expect(Object.keys(r).sort()).toEqual(Object.keys(resultSchema.shape).sort());
    expect(text).not.toMatch(/assignee|byAssignee|perPerson|members|names/i);
  });

  test('small groups: fewer than 5 active people is "group_too_small" (blocked and inactive people do not count)', async () => {
    expect(MIN_COHORT).toBe(5);
    const r = await run(users.smallLead, { scope: 'my_team' });
    expect(r).toMatchObject({ outcome: 'not_available', reason: 'group_too_small', totalTasks: null, peopleInScope: null });
    expect((await run(users.bigLead, { scope: 'my_team' })).outcome).toBe('ok'); // 6 active
    // the boundary: 5 active is allowed, 4 is not
    await User.updateOne({ _id: users.outsider._id }, { isActive: false });
    expect((await run(users.bigLead, { scope: 'my_team' })).peopleInScope).toBe(5);
    await User.updateOne({ _id: users.projectMgr._id }, { orgBlocked: true });
    expect(await run(users.bigLead, { scope: 'my_team' })).toMatchObject({ outcome: 'not_available', reason: 'group_too_small' });
  });

  test('a small organization gets no organization summary at all; another organization is never mixed in', async () => {
    expect(await run(users.adminC, { scope: 'organization' })).toMatchObject({ outcome: 'not_available', reason: 'group_too_small' });
    expect(await run(users.adminB, { scope: 'organization' })).toMatchObject({ outcome: 'not_available', reason: 'group_too_small' });
    const mine = await run(users.adminB, { scope: 'me' });
    expect(mine.totalTasks).toBe(2); // only Globex's own two tasks, none of Acme's
    expect((await run(users.admin, { scope: 'organization' })).totalTasks).toBe((await oracle(users.admin, 'organization')).totalTasks);
  });

  test('a team summary counts tasks once (not assignments) and only tasks the lead may see', async () => {
    const r = await run(users.bigLead, { scope: 'my_team' });
    expect(metricsOf(r)).toEqual(await oracle(users.bigLead, 'my_team'));
    // pub-none has two team assignees (member + contributor) and counts once
    const all = await Task.find({ title: 'pub-none' }).lean();
    expect(all[0].assignees).toHaveLength(2);
  });
});

describe('cancellation and timeout', () => {
  test('a request that is already cancelled does nothing; a cancel during the query ends it with AI_TOOL_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(users.member, {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });

    const live = new AbortController();
    const original = Task.aggregate.bind(Task);
    jest.spyOn(Task, 'aggregate').mockImplementation(() => ({ option: () => ({ exec: async () => { live.abort(); return []; } }), _orig: original }));
    await expect(run(users.member, { scope: 'me' }, { signal: live.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
    jest.restoreAllMocks();
  });

  test('a database time limit becomes the fixed AI_TOOL_TIMEOUT, and the query carries maxTimeMS', async () => {
    const seen = [];
    jest.spyOn(Task, 'aggregate').mockImplementation(() => ({ option: (o) => { seen.push(o); return { exec: async () => { throw Object.assign(new Error('operation exceeded time limit'), { code: 50 }); } }; } }));
    await expect(run(users.member, { scope: 'me' }, { maxTimeMs: 1234 })).rejects.toMatchObject({ code: 'AI_TOOL_TIMEOUT' });
    expect(seen).toEqual([{ maxTimeMS: 1234 }]);
    jest.restoreAllMocks();
  });
});
