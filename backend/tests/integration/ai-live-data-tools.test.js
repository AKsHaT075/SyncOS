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
 * Phase 8 Step 3: what list_my_tasks and list_my_schedule return, run directly (the callback gate, budget and audit are covered in
 * ai-live-data-tools-gate.test.js). The clock is fixed: Sat 2026-11-14 10:00Z = 15:30 in India, so the Monday-Sunday week is Nov 9-15.
 */
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const CalendarPreference = require('../../src/models/CalendarPreference');
const Meeting = require('../../src/models/Meeting');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { resolveToolLimits } = require('../../src/services/ai/tools/toolLimits');
const { projectResult } = require('../../src/services/ai/tools/toolResult');
const { createListMyTasksTool } = require('../../src/services/ai/tools/listMyTasks.tool');
const { createListMyScheduleTool, MAX_ENTRIES } = require('../../src/services/ai/tools/listMySchedule.tool');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const NOW = Date.parse('2026-11-14T10:00:00Z');
const tasksTool = createListMyTasksTool({ now: () => NOW });
const scheduleTool = createListMyScheduleTool({ now: () => NOW });
const LIMITS = resolveToolLimits();
let orgA; let orgB; let pOrg; let pPriv;
const day = (d) => new Date(`${d}T00:00:00.000Z`);

/** Runs a tool the way the gate does: strict argument parse, run with a signal + deadline, then the Step 1 result validator. */
async function run(tool, actor, input = {}, { signal = new AbortController().signal, maxTimeMs = 5000 } = {}) {
  const parsed = tool.schema.parse(input);
  const raw = await tool.run({ actor, input: parsed, signal, maxTimeMs });
  return projectResult(tool, raw, LIMITS).result;
}
const titles = (result) => result.data.map((r) => r.title || r.topic);

const mkTask = (title, over = {}) => Task.create({ organization: orgA._id, project: pOrg._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', ...over });
const mkMeeting = (topic, startIso, over = {}) => Meeting.create({ organization: orgA._id, project: pOrg._id, topic, type: 'Scheduled', status: 'Scheduled', startTime: new Date(startIso), endTime: new Date(Date.parse(startIso) + 3600000), host: users.owner._id, createdBy: users.owner._id, participants: [{ user: users.member._id }], ...over });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
});
afterAll(async () => {
  await hub.shutdown();
  await disconnectTestDb();
  await createRedisClient().quit();
});

beforeEach(async () => {
  await Promise.all([CalendarPreference, Meeting, Organization, Project, Task, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'member', ROLES.EMPLOYEE);
  await createUser(orgA, 'contributor', ROLES.EMPLOYEE);
  await createUser(orgA, 'projectMgr', ROLES.EMPLOYEE);
  await createUser(orgA, 'outsider', ROLES.EMPLOYEE);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  const roster = [{ user: users.member._id, role: 'Contributor' }, { user: users.contributor._id, role: 'Viewer' }, { user: users.projectMgr._id, role: 'Manager' }];
  pOrg = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'org', name: 'Apollo', visibility: 'Organization', members: roster, status: 'Active' });
  pPriv = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'priv', name: 'Secret Skunkworks', visibility: 'Private', members: roster, status: 'Active' });
});

describe('list_my_tasks: arguments', () => {
  const parse = (input) => tasksTool.schema.safeParse(input).success;
  test('strict: only the approved properties and values', () => {
    expect(parse({})).toBe(true);
    expect(parse({ status: 'open', due: 'overdue', relation: 'approver', limit: 20 })).toBe(true);
    for (const bad of [{ status: 'Done' }, { due: 'tomorrow' }, { relation: 'everyone' }, { limit: 21 }, { limit: 0 }, { limit: 1.5 }, { limit: '5' }, { user: 'someone' }, { organization: 'x' }, { filter: { $ne: null } }, { status: { $ne: 'x' } }, { project: 'abc' }]) {
      expect({ bad, ok: parse(bad) }).toEqual({ bad, ok: false });
    }
  });
});

describe('list_my_tasks: behaviour', () => {
  beforeEach(async () => {
    await Promise.all([
      mkTask('overdue-old', { dueDate: day('2026-11-02') }),
      mkTask('overdue-yesterday', { dueDate: day('2026-11-13'), status: 'In Progress' }),
      mkTask('due-today', { dueDate: day('2026-11-14') }),
      mkTask('this-week-sunday', { dueDate: day('2026-11-15') }),
      mkTask('this-week-monday', { dueDate: day('2026-11-09') }),
      mkTask('next7-last-day', { dueDate: day('2026-11-20') }),
      mkTask('next7-out', { dueDate: day('2026-11-21') }),
      mkTask('no-due'),
      mkTask('done', { dueDate: day('2026-11-01'), status: 'Completed' }),
      mkTask('cancelled', { dueDate: day('2026-11-01'), status: 'Cancelled' }),
      mkTask('in-review-for-member', { assignees: [users.contributor._id], approvers: [users.member._id], status: 'In Review', dueDate: day('2026-11-16') }),
      mkTask('created-by-member', { owner: users.member._id, assignees: [users.contributor._id], dueDate: day('2026-11-17') }),
    ]);
  });

  test('default = my OPEN tasks assigned to me: completed and cancelled are excluded; dated first (soonest), then undated', async () => {
    const r = await run(tasksTool, users.member);
    expect(titles(r)).toEqual(['overdue-old', 'this-week-monday', 'overdue-yesterday', 'due-today', 'this-week-sunday', 'next7-last-day', 'next7-out', 'no-due']);
    expect(r.filters).toEqual({ status: 'open', due: null, relation: 'assigned' });
    expect(r.summary).toMatchObject({ count: 8, total: 8, truncated: false, complete: true });
    expect(r.asOf).toEqual({ date: '2026-11-14', timeZone: 'Asia/Kolkata' });
  });

  test('status: open excludes Completed / Cancelled; each concrete status returns only that status', async () => {
    expect(titles(await run(tasksTool, users.member, { status: 'open' }))).not.toEqual(expect.arrayContaining(['done']));
    expect(titles(await run(tasksTool, users.member, { status: 'Completed' }))).toEqual(['done']);
    expect(titles(await run(tasksTool, users.member, { status: 'Cancelled' }))).toEqual(['cancelled']);
    expect(titles(await run(tasksTool, users.member, { status: 'In Progress' }))).toEqual(['overdue-yesterday']);
    expect(titles(await run(tasksTool, users.contributor, { status: 'In Review' }))).toEqual(['in-review-for-member']);
  });

  test('due: overdue is open + strictly before today (due today is NOT overdue); every row carries the precomputed flag', async () => {
    const r = await run(tasksTool, users.member, { due: 'overdue' });
    expect(titles(r)).toEqual(['overdue-old', 'this-week-monday', 'overdue-yesterday']);
    expect(r.data.every((row) => row.overdue === true)).toBe(true);
    expect(titles(r)).not.toContain('due-today');
    expect(titles(r)).not.toContain('done');
    const today = await run(tasksTool, users.member, { due: 'today' });
    expect(titles(today)).toEqual(['due-today']);
    expect(today.data[0].overdue).toBe(false);
  });

  test('"overdue" never matches a finished task, even when asked for Completed explicitly', async () => {
    const r = await run(tasksTool, users.member, { status: 'Completed', due: 'overdue' });
    expect(r.data).toEqual([]);
    expect(r.summary).toMatchObject({ count: 0, total: 0 });
  });

  test('due: this_week is Monday 9th to Sunday 15th; next_7_days is today to today+6; none is undated', async () => {
    expect(titles(await run(tasksTool, users.member, { due: 'this_week' }))).toEqual(['this-week-monday', 'overdue-yesterday', 'due-today', 'this-week-sunday']);
    expect(titles(await run(tasksTool, users.member, { due: 'next_7_days' }))).toEqual(['due-today', 'this-week-sunday', 'next7-last-day']);
    expect(titles(await run(tasksTool, users.member, { due: 'none' }))).toEqual(['no-due']);
  });

  test('relation: approver = tasks I am a listed approver of; owner = tasks I created, or tasks of projects I own', async () => {
    expect(titles(await run(tasksTool, users.member, { relation: 'approver', status: 'In Review' }))).toEqual(['in-review-for-member']);
    expect(titles(await run(tasksTool, users.member, { relation: 'assigned', status: 'In Review' }))).toEqual([]);
    expect(titles(await run(tasksTool, users.member, { relation: 'owner' }))).toEqual(['created-by-member']);
    const asProjectOwner = await run(tasksTool, users.owner, { relation: 'owner', limit: 20 }); // the project's owner: every task of the project is "theirs"
    expect(asProjectOwner.summary.total).toBe(10); // every OPEN task of Apollo (done and cancelled excluded)
  });

  test('limit: the count shown is bounded, the total is not, and `truncated` says so', async () => {
    const r = await run(tasksTool, users.member, { limit: 3 });
    expect(r.data).toHaveLength(3);
    expect(r.summary).toMatchObject({ count: 3, total: 8, truncated: true });
    expect(titles(r)).toEqual(['overdue-old', 'this-week-monday', 'overdue-yesterday']);
  });

  test('rows are the approved projection: flat, no description / email / attachments, link to the task', async () => {
    await Task.updateOne({ title: 'due-today' }, { description: 'SECRET-DESCRIPTION', checklist: [{ text: 'SECRET-CHECK', addedBy: users.owner._id }], labels: ['SECRET-LABEL'] });
    const r = await run(tasksTool, users.member, { due: 'today' });
    expect(Object.keys(r.data[0]).sort()).toEqual(['assigneeCount', 'assignees', 'due', 'href', 'id', 'overdue', 'priority', 'projectId', 'projectName', 'status', 'title']);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|@|description|checklist/);
    expect(r.data[0]).toMatchObject({ projectName: 'Apollo', assignees: 'Member Tester', due: '2026-11-14' });
    expect(r.data[0].href).toBe(`/dashboard/projects/${pOrg._id}/tasks/${r.data[0].id}`);
  });

  test('the user\'s timezone decides what today is (Kiritimati, UTC+14: it is already Sunday the 15th)', async () => {
    await CalendarPreference.create({ user: users.member._id, organization: orgA._id, timezone: 'Pacific/Kiritimati' });
    const r = await run(tasksTool, users.member, { due: 'overdue' });
    expect(r.asOf).toEqual({ date: '2026-11-15', timeZone: 'Pacific/Kiritimati' });
    expect(titles(r)).toContain('due-today'); // yesterday's "today" is now overdue
    expect(titles(await run(tasksTool, users.member, { due: 'today' }))).toEqual(['this-week-sunday']);
  });

  test('another user sees only their own tasks; another organization\'s admin sees nothing of this one', async () => {
    expect((await run(tasksTool, users.outsider)).data).toEqual([]);
    const b = await run(tasksTool, users.adminB, { relation: 'owner' });
    expect(b.data).toEqual([]);
    expect(JSON.stringify(b)).not.toMatch(/Apollo|overdue-old/);
  });
});

describe('list_my_tasks: AI visibility (private resources, administrators, projects)', () => {
  test('a private task is visible to its assignee, its approver and the project owner / manager - not to an unrelated member or to ADMINS', async () => {
    await mkTask('priv-assigned-member', { project: pPriv._id, visibility: 'Private', dueDate: day('2026-11-16') });
    await mkTask('priv-approver-contrib', { project: pPriv._id, visibility: 'Private', assignees: [], approvers: [users.contributor._id], dueDate: day('2026-11-16') });
    await mkTask('priv-assigned-admin', { project: pPriv._id, visibility: 'Private', assignees: [users.admin._id], dueDate: day('2026-11-16') });
    expect(titles(await run(tasksTool, users.member))).toContain('priv-assigned-member');
    expect(titles(await run(tasksTool, users.contributor, { relation: 'approver' }))).toContain('priv-approver-contrib');
    expect(titles(await run(tasksTool, users.contributor))).not.toContain('priv-assigned-member'); // not attached to it
    // an administrator who is assigned a task in a PRIVATE project they are not a member of: no AI access
    expect(titles(await run(tasksTool, users.admin))).toEqual([]);
    expect((await run(tasksTool, users.admin, { relation: 'owner' })).data).toEqual([]);
  });

  test('assigned to me in a project I cannot see: not returned', async () => {
    await mkTask('assigned-outsider-in-private', { project: pPriv._id, assignees: [users.outsider._id] });
    expect((await run(tasksTool, users.outsider)).data).toEqual([]);
  });

  test('archived / deleted tasks and tasks of deleted projects are excluded', async () => {
    await mkTask('archived-task', { archived: true });
    await mkTask('deleted-task', { deletedAt: new Date() });
    await Project.updateOne({ _id: pPriv._id }, { deletedAt: new Date() });
    await mkTask('in-deleted-project', { project: pPriv._id });
    expect((await run(tasksTool, users.member)).data).toEqual([]);
  });

  test('when the visible-project cap is hit the result says the coverage is incomplete', async () => {
    await mkTask('a-task', { dueDate: day('2026-11-16') });
    const realScope = aiScope.resolveAiScope;
    const spy = jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...args) => ({ ...(await realScope(...args)), truncated: true }));
    try {
      const r = await run(tasksTool, users.member);
      expect(r.summary.complete).toBe(false);
      expect((await run(tasksTool, users.outsider)).summary.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('list_my_tasks: size, deadlines and cancellation', () => {
  test('a long list of long titles is trimmed to the byte budget (whole rows) and flagged truncated; the validator accepts it', async () => {
    await Task.insertMany(Array.from({ length: 20 }, (_, i) => ({ organization: orgA._id, project: pOrg._id, title: `${i}-${'T'.repeat(150)}`, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], dueDate: day('2026-11-16') })));
    const r = await run(tasksTool, users.member, { limit: 20 });
    expect(r.summary.total).toBe(20);
    expect(r.data.length).toBeLessThan(20);
    expect(r.summary.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(LIMITS.maxResultBytes);
  });

  test('every query carries the deadline (maxTimeMS)', async () => {
    await mkTask('t', { dueDate: day('2026-11-16') });
    const seen = [];
    const original = mongoose.Query.prototype.exec;
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...args) { seen.push({ model: this.model.modelName, maxTimeMS: this.options.maxTimeMS }); return original.apply(this, args); });
    try {
      await run(tasksTool, users.member, {}, { maxTimeMs: 4321 });
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBeGreaterThanOrEqual(4); // timezone lookups, scope, count, find, names
    const mine = seen.filter((q) => ['Task', 'Project', 'User'].includes(q.model));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.every((q) => q.maxTimeMS === 4321)).toBe(true);
  });

  test('a database time-limit error becomes the fixed timeout error', async () => {
    await mkTask('t');
    const spy = jest.spyOn(Task, 'countDocuments').mockImplementation(() => ({ maxTimeMS: () => Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 })) }));
    try {
      await expect(run(tasksTool, users.member)).rejects.toMatchObject({ code: 'AI_TOOL_TIMEOUT', statusCode: 504 });
    } finally {
      spy.mockRestore();
    }
  });

  test('cancellation: an aborted signal stops the tool before any query; an abort mid-run stops it before the next one', async () => {
    await mkTask('t');
    const before = new AbortController();
    before.abort();
    const queries = [];
    const original = mongoose.Query.prototype.exec;
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...args) { queries.push(this.model.modelName); return original.apply(this, args); });
    try {
      await expect(run(tasksTool, users.member, {}, { signal: before.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
      expect(queries).toEqual([]);

      const mid = new AbortController();
      spy.mockImplementation(function exec(...args) {
        queries.push(this.model.modelName);
        const result = original.apply(this, args);
        return this.model.modelName === 'Project' ? result.then((rows) => { mid.abort(); return rows; }) : result; // abort exactly when the project scope has been read
      });
      await expect(run(tasksTool, users.member, {}, { signal: mid.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
      expect(queries).not.toContain('Task'); // aborted after the project scope was read: no task query was started
    } finally {
      spy.mockRestore();
    }
  });
});

describe('list_my_schedule: arguments', () => {
  const parse = (input) => scheduleTool.schema.safeParse(input).success;
  test('strict: only the approved range and types', () => {
    expect(parse({})).toBe(true);
    expect(parse({ range: 'this_week', types: ['meeting', 'task'] })).toBe(true);
    for (const bad of [{ range: 'last_week' }, { range: 'tomorrow' }, { types: [] }, { types: ['event'] }, { types: ['meeting', 'meeting', 'task', 'project'] }, { types: 'meeting' }, { from: '2026-01-01' }, { userId: 'x' }, { timezone: 'UTC' }, { limit: 5 }]) {
      expect({ bad, ok: parse(bad) }).toEqual({ bad, ok: false });
    }
  });
});

describe('list_my_schedule: behaviour', () => {
  test('meetings: only those I host or attend, not cancelled; ranges today / next_7_days / this_week / next_14_days', async () => {
    await mkMeeting('today-mine', '2026-11-14T05:00:00Z'); // 10:30 IST
    await mkMeeting('tomorrow-mine', '2026-11-15T05:00:00Z');
    await mkMeeting('next-week-mine', '2026-11-18T05:00:00Z');
    await mkMeeting('in-12-days', '2026-11-26T05:00:00Z');
    await mkMeeting('beyond-14-days', '2026-11-30T05:00:00Z');
    await mkMeeting('cancelled', '2026-11-14T06:00:00Z', { status: 'Cancelled' });
    await mkMeeting('not-invited', '2026-11-14T07:00:00Z', { participants: [{ user: users.contributor._id }] }); // a project member who is NOT a participant
    await mkMeeting('hosted-by-member', '2026-11-14T08:00:00Z', { host: users.member._id, participants: [] });
    const names = async (range) => titles(await run(scheduleTool, users.member, { range, types: ['meeting'] }));
    expect(await names('today')).toEqual(['today-mine', 'hosted-by-member']);
    expect(await names('this_week')).toEqual(['today-mine', 'hosted-by-member', 'tomorrow-mine']);
    expect(await names('next_7_days')).toEqual(['today-mine', 'hosted-by-member', 'tomorrow-mine', 'next-week-mine']);
    expect(await names('next_14_days')).toEqual(['today-mine', 'hosted-by-member', 'tomorrow-mine', 'next-week-mine', 'in-12-days']);
  });

  test('Monday-to-Sunday boundaries in the user\'s zone: Sunday 23:30 IST is in this week, Monday 00:30 IST is not', async () => {
    await mkMeeting('sunday-late', '2026-11-15T18:00:00Z', { endTime: new Date('2026-11-15T18:10:00Z') }); // 23:30 IST Sunday, ends 23:40
    await mkMeeting('monday-early', '2026-11-15T19:00:00Z', { endTime: new Date('2026-11-15T19:10:00Z') }); // 00:30 IST Monday 16th
    await mkMeeting('monday-of-week', '2026-11-08T19:00:00Z', { endTime: new Date('2026-11-08T19:10:00Z') }); // 00:30 IST Monday 9th (this week's first moments)
    await mkMeeting('sunday-before', '2026-11-08T18:00:00Z', { endTime: new Date('2026-11-08T18:10:00Z') }); // 23:30 IST Sunday 8th (last week), ends 23:40
    const r = await run(scheduleTool, users.member, { range: 'this_week', types: ['meeting'] });
    expect(titles(r)).toEqual(['monday-of-week', 'sunday-late']);
    expect(r.range).toEqual({ name: 'this_week', from: '2026-11-09', to: '2026-11-15' });
  });

  test('a meeting that started before the range but is still running overlaps it; a meeting with no end time is treated as one hour', async () => {
    await mkMeeting('overnight', '2026-11-13T17:00:00Z', { endTime: new Date('2026-11-13T19:00:00Z') }); // ends 00:30 IST on the 14th
    await mkMeeting('ended-before', '2026-11-13T15:00:00Z', { endTime: new Date('2026-11-13T17:00:00Z') });
    await mkMeeting('no-end-time', '2026-11-14T09:00:00Z', { endTime: null });
    const r = await run(scheduleTool, users.member, { range: 'today', types: ['meeting'] });
    expect(titles(r)).toEqual(['overnight', 'no-end-time']);
    expect(r.data.find((e) => e.title === 'no-end-time').end).toBeNull(); // never invents an end
  });

  test('timestamps and date-only values are separate: a task due on the 14th is "today" for an Indian AND a Californian user, a meeting is not', async () => {
    await mkTask('due-14th', { dueDate: day('2026-11-14') });
    await mkMeeting('mtg', '2026-11-14T22:00:00Z'); // 03:30 IST on the 15th; 14:00 PST on the 14th
    expect(titles(await run(scheduleTool, users.member, { range: 'today' }))).toEqual(['due-14th']); // India: the meeting is tomorrow
    await CalendarPreference.create({ user: users.member._id, organization: orgA._id, timezone: 'America/Los_Angeles' });
    expect(titles(await run(scheduleTool, users.member, { range: 'today' }))).toEqual(['due-14th', 'mtg']);
  });

  test('DST: in New York on the day clocks fall back (25 h) a meeting at 23:30 local is that day; 00:30 local the next day is not', async () => {
    const dst = createListMyScheduleTool({ now: () => Date.parse('2026-11-01T12:00:00Z') });
    await CalendarPreference.create({ user: users.member._id, organization: orgA._id, timezone: 'America/New_York' });
    await mkMeeting('late-sunday', '2026-11-02T04:30:00Z', { endTime: new Date('2026-11-02T04:40:00Z') }); // 23:30 EST on Nov 1
    await mkMeeting('after-midnight', '2026-11-02T05:30:00Z', { endTime: new Date('2026-11-02T05:40:00Z') }); // 00:30 EST on Nov 2
    await mkMeeting('before-midnight-edt', '2026-11-01T03:30:00Z', { endTime: new Date('2026-11-01T03:40:00Z') }); // 23:30 EDT on Oct 31 (the day before)
    const r = await run(dst, users.member, { range: 'today', types: ['meeting'] });
    expect(titles(r)).toEqual(['late-sunday']);
    expect(r.asOf).toEqual({ date: '2026-11-01', timeZone: 'America/New_York' });
  });

  test('tasks: only OPEN tasks assigned to me, due in the range, shown as all-day entries on their floating date', async () => {
    await mkTask('due-today-task', { dueDate: day('2026-11-14') });
    await mkTask('due-next-week', { dueDate: day('2026-11-18') });
    await mkTask('done-today', { dueDate: day('2026-11-14'), status: 'Completed' });
    await mkTask('not-mine', { dueDate: day('2026-11-14'), assignees: [users.contributor._id] });
    const r = await run(scheduleTool, users.member, { range: 'next_7_days', types: ['task'] });
    expect(titles(r)).toEqual(['due-today-task', 'due-next-week']);
    expect(r.data[0]).toMatchObject({ category: 'task', allDay: true, startDate: '2026-11-14', endDate: '2026-11-14', start: null, end: null, projectName: 'Apollo' });
  });

  test('project deadlines: only projects I own or belong to, still running, due in the range', async () => {
    await Project.updateOne({ _id: pOrg._id }, { dueDate: day('2026-11-16') });
    const other = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'o2', name: 'Visible but not mine', visibility: 'Organization', status: 'Active', dueDate: day('2026-11-16') });
    await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'o3', name: 'Finished', visibility: 'Organization', members: [{ user: users.member._id, role: 'Viewer' }], status: 'Completed', dueDate: day('2026-11-16') });
    const r = await run(scheduleTool, users.member, { range: 'next_7_days', types: ['project'] });
    expect(titles(r)).toEqual(['Apollo']);
    expect(titles(r)).not.toContain(other.name);
  });

  test('chronological: all-day entries first within a local day, then by start time; days in order', async () => {
    await mkTask('task-15', { dueDate: day('2026-11-15') });
    await mkTask('task-14', { dueDate: day('2026-11-14') });
    await mkMeeting('m-14-late', '2026-11-14T11:00:00Z');
    await mkMeeting('m-14-early', '2026-11-14T04:00:00Z');
    await mkMeeting('m-15-night', '2026-11-14T19:30:00Z'); // 01:00 IST on the 15th: a different LOCAL day than its UTC date
    expect(titles(await run(scheduleTool, users.member, { range: 'this_week' }))).toEqual(['task-14', 'm-14-early', 'm-14-late', 'task-15', 'm-15-night']);
  });

  test('types limits the sources queried', async () => {
    await mkTask('t', { dueDate: day('2026-11-14') });
    await mkMeeting('m', '2026-11-14T05:00:00Z');
    expect(titles(await run(scheduleTool, users.member, { range: 'today', types: ['task'] }))).toEqual(['t']);
    expect(titles(await run(scheduleTool, users.member, { range: 'today', types: ['meeting'] }))).toEqual(['m']);
    expect(titles(await run(scheduleTool, users.member, { range: 'today' })).sort()).toEqual(['m', 't']);
  });

  test('entries are the approved projection: no description, location, participants, join link or room name; links are rebuilt', async () => {
    await Meeting.updateOne({}, {});
    const meeting = await mkMeeting('Design review', '2026-11-14T05:00:00Z', { description: 'SECRET-AGENDA', livekitRoomName: 'SECRET-ROOM' });
    const r = await run(scheduleTool, users.member, { range: 'today' });
    expect(Object.keys(r.data[0]).sort()).toEqual(['allDay', 'category', 'end', 'endDate', 'href', 'id', 'projectId', 'projectName', 'start', 'startDate', 'status', 'title']);
    expect(r.data[0].href).toBe(`/dashboard/projects/${pOrg._id}/meetings/${meeting._id}`);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|livekit|join|description|participants|location/i);
  });
});

describe('list_my_schedule: AI visibility', () => {
  test('private project: its meetings and tasks reach members only; ADMINS get nothing, even when invited or assigned', async () => {
    await mkMeeting('private-meeting', '2026-11-14T05:00:00Z', { project: pPriv._id, participants: [{ user: users.member._id }, { user: users.admin._id }] });
    await mkTask('private-task', { project: pPriv._id, visibility: 'Private', assignees: [users.member._id, users.admin._id], dueDate: day('2026-11-14') });
    expect(titles(await run(scheduleTool, users.member, { range: 'today' })).sort()).toEqual(['private-meeting', 'private-task']);
    expect((await run(scheduleTool, users.admin, { range: 'today' })).data).toEqual([]);
    expect((await run(scheduleTool, users.outsider, { range: 'today' })).data).toEqual([]);
  });

  test('a private task is shown only to someone attached to it', async () => {
    await mkTask('private-for-contrib', { project: pPriv._id, visibility: 'Private', assignees: [users.contributor._id], dueDate: day('2026-11-14') });
    expect(titles(await run(scheduleTool, users.contributor, { range: 'today' }))).toEqual(['private-for-contrib']);
    expect((await run(scheduleTool, users.member, { range: 'today' })).data).toEqual([]);
  });

  test('another organization sees nothing; hr and managers see only their own entries', async () => {
    await mkTask('t', { dueDate: day('2026-11-14') });
    await mkMeeting('m', '2026-11-14T05:00:00Z');
    for (const key of ['adminB', 'hr', 'manager', 'outsider']) expect((await run(scheduleTool, users[key], { range: 'next_14_days' })).data).toEqual([]);
  });

  test('a participant who lost access to the project (removed from a private project) no longer sees its meeting', async () => {
    await mkMeeting('private-meeting', '2026-11-14T05:00:00Z', { project: pPriv._id });
    expect(titles(await run(scheduleTool, users.member, { range: 'today' }))).toEqual(['private-meeting']);
    await Project.updateOne({ _id: pPriv._id }, { $pull: { members: { user: users.member._id } } });
    expect((await run(scheduleTool, users.member, { range: 'today' })).data).toEqual([]);
  });
});

describe('list_my_schedule: limits, deadlines, cancellation', () => {
  test(`at most ${MAX_ENTRIES} entries; more than that is reported as truncated and incomplete`, async () => {
    await Meeting.insertMany(Array.from({ length: 40 }, (_, i) => ({ organization: orgA._id, project: pOrg._id, topic: `m${String(i).padStart(2, '0')}`, type: 'Scheduled', status: 'Scheduled', startTime: new Date(Date.parse('2026-11-14T04:00:00Z') + i * 600000), endTime: new Date(Date.parse('2026-11-14T04:00:00Z') + i * 600000 + 300000), host: users.owner._id, createdBy: users.owner._id, participants: [{ user: users.member._id }] })));
    const r = await run(scheduleTool, users.member, { range: 'today', types: ['meeting'] });
    expect(r.data.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(r.summary.truncated).toBe(true);
    expect(r.summary.complete).toBe(false); // the per-source cap was reached: the answer must not claim completeness
    expect(r.data[0].title).toBe('m00'); // still the EARLIEST entries, in order
    expect(titles(r)).toEqual([...titles(r)].sort());
  });

  test('every query carries the deadline; a time-limit error becomes the fixed timeout error', async () => {
    await mkMeeting('m', '2026-11-14T05:00:00Z');
    const seen = [];
    const original = mongoose.Query.prototype.exec;
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...args) { seen.push({ model: this.model.modelName, maxTimeMS: this.options.maxTimeMS }); return original.apply(this, args); });
    try {
      await run(scheduleTool, users.member, { range: 'today' }, { maxTimeMs: 2468 });
    } finally {
      spy.mockRestore();
    }
    const mine = seen.filter((q) => ['Meeting', 'Task', 'Project', 'User'].includes(q.model));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.every((q) => q.maxTimeMS === 2468)).toBe(true);
    const failing = jest.spyOn(Meeting, 'find').mockImplementation(() => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, lean() { return this; }, maxTimeMS: () => Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 })) }));
    try {
      await expect(run(scheduleTool, users.member, { range: 'today' })).rejects.toMatchObject({ code: 'AI_TOOL_TIMEOUT' });
    } finally {
      failing.mockRestore();
    }
  });

  test('cancellation before and during the run stops further queries', async () => {
    const before = new AbortController();
    before.abort();
    await expect(run(scheduleTool, users.member, {}, { signal: before.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
    const mid = new AbortController();
    const queries = [];
    const original = mongoose.Query.prototype.exec;
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...args) { queries.push(this.model.modelName); const result = original.apply(this, args); return this.model.modelName === 'Project' ? result.then((rows) => { mid.abort(); return rows; }) : result; });
    try {
      await expect(run(scheduleTool, users.member, {}, { signal: mid.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
      expect(queries).not.toContain('Meeting');
      expect(queries).not.toContain('Task');
    } finally {
      spy.mockRestore();
    }
  });
});
