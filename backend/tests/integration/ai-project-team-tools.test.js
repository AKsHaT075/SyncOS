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
 * Phase 8 Step 4: what list_projects, get_project_overview, list_project_members, list_project_tasks and get_team return, run
 * directly with a fixed clock (Sat 2026-11-14, India). The callback gate, budget and audit are covered in
 * ai-project-team-tools-gate.test.js.
 */
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const A = require('../../src/utils/aiAccess');
const aiScope = require('../../src/services/ai/tools/aiScope');
const { resolveToolLimits } = require('../../src/services/ai/tools/toolLimits');
const { projectResult } = require('../../src/services/ai/tools/toolResult');
const { createListProjectsTool } = require('../../src/services/ai/tools/listProjects.tool');
const { createGetProjectOverviewTool } = require('../../src/services/ai/tools/getProjectOverview.tool');
const { createListProjectMembersTool } = require('../../src/services/ai/tools/listProjectMembers.tool');
const { createListProjectTasksTool } = require('../../src/services/ai/tools/listProjectTasks.tool');
const { createGetTeamTool } = require('../../src/services/ai/tools/getTeam.tool');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const NOW = Date.parse('2026-11-14T10:00:00Z');
const LIMITS = resolveToolLimits();
const T = {
  projects: createListProjectsTool({ now: () => NOW }),
  overview: createGetProjectOverviewTool({ now: () => NOW }),
  members: createListProjectMembersTool(),
  tasks: createListProjectTasksTool({ now: () => NOW }),
  team: createGetTeamTool(),
};
const day = (d) => new Date(`${d}T00:00:00.000Z`);
let orgA; let orgB; let team1; let team2; let team3; const P = {};

async function run(tool, actor, input = {}, { signal = new AbortController().signal, maxTimeMs = 5000 } = {}) {
  const parsed = tool.schema.parse(input);
  const raw = await tool.run({ actor, input: parsed, signal, maxTimeMs });
  return projectResult(tool, raw, LIMITS).result;
}
const names = (r) => r.data.map((x) => x.name || x.title);
const forAll = async (fn) => { for (const key of Object.keys(users)) await fn(key); }; // eslint-disable-line no-await-in-loop, no-restricted-syntax

const mkProject = (key, over = {}) => Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: key.toLowerCase(), name: key, visibility: 'Organization', status: 'Active', ...over }).then((d) => { P[key] = d; return d; });
const mkTask = (project, title, over = {}) => Task.create({ organization: orgA._id, project: project._id, title, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], status: 'Todo', ...over });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  // In production a unique, case-insensitive (organization, name) index makes two projects with the same name impossible. These tests
  // exercise the resolver's AMBIGUITY handling anyway (defence in depth for legacy data or an unbuilt index), so this test database
  // alone drops that index. Everything else about the model is unchanged.
  const NAME_INDEX = 'organization_1_name_1';
  const present = async () => (await Project.collection.indexes().catch(() => [])).some((i) => i.name === NAME_INDEX);
  for (let i = 0; i < 40 && !(await present()); i += 1) await new Promise((r) => setTimeout(r, 100)); // wait (bounded) for Mongoose's lazy index build
  await Project.collection.dropIndex(NAME_INDEX).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await Project.collection.dropIndex(NAME_INDEX).catch(() => {}); // and again, in case a late build re-created it
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
  team1 = await Team.create({ organization: orgA._id, name: 'Platform', createdBy: oid() });
  team2 = await Team.create({ organization: orgA._id, name: 'Sales', createdBy: oid() });
  team3 = await Team.create({ organization: orgA._id, name: 'Platform Ops', createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'coadmin', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER, { team: team1._id });
  await createUser(orgA, 'lonelyManager', ROLES.MANAGER);
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'member', ROLES.EMPLOYEE);
  await createUser(orgA, 'contributor', ROLES.EMPLOYEE);
  await createUser(orgA, 'projectMgr', ROLES.EMPLOYEE);
  await createUser(orgA, 'teamEmp', ROLES.EMPLOYEE, { team: team1._id });
  await createUser(orgA, 'outsider', ROLES.EMPLOYEE, { team: team2._id });
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgA, 'blocked', ROLES.EMPLOYEE, { orgBlocked: true });
  await createUser(orgA, 'inactive', ROLES.EMPLOYEE, { isActive: false });
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await Team.updateOne({ _id: team1._id }, { lead: users.manager._id, members: [users.teamEmp._id, users.blocked._id, users.inactive._id], description: 'SECRET-TEAM-NOTES' });
  await Team.updateOne({ _id: team2._id }, { lead: users.hr._id, members: [users.outsider._id] });
  await Team.updateOne({ _id: team3._id }, { lead: users.inactive._id, members: [users.member._id] });

  const roster = [
    { user: users.owner._id, role: 'Owner' }, // the owner is ALSO listed in members
    { user: users.member._id, role: 'Contributor' }, { user: users.contributor._id, role: 'Viewer' }, { user: users.projectMgr._id, role: 'Manager' },
    { user: users.blocked._id, role: 'Viewer' }, { user: users.inactive._id, role: 'Contributor' },
  ];
  await mkProject('Apollo', { members: roster, dueDate: day('2026-11-10'), priority: 'High', type: 'Technical', client: 'SECRET-CLIENT', budget: 777777, description: 'SECRET-DESCRIPTION', resourceLink: 'https://secret.example/repo' });
  await mkProject('Apollo Legacy', { status: 'Completed', dueDate: day('2026-01-01') });
  await mkProject('Zephyr', { status: 'Planning', members: [{ user: users.member._id, role: 'Contributor' }], dueDate: day('2026-12-01') });
  await mkProject('Skunkworks', { visibility: 'Private', dueDate: day('2026-11-12'), members: [{ user: users.member._id, role: 'Contributor' }, { user: users.projectMgr._id, role: 'Manager' }] });
  await mkProject('TeamProj', { visibility: 'Team', team: team1._id });
  await mkProject('ArchivedProj', { archived: true });
  await mkProject('DeletedProj', { deletedAt: new Date() });
  await mkProject('Gemini', { slug: 'gemini-1' });
  P.Gemini2 = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'gemini-2', name: 'Gemini', visibility: 'Organization', status: 'Planning' });
  P.GeminiPrivate = await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'gemini-3', name: 'Gemini', visibility: 'Private', status: 'Active', members: [{ user: users.member._id, role: 'Contributor' }] });
  P.ApolloB = await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'apollo-b', name: 'Apollo', visibility: 'Organization', status: 'Active' });

  // tasks of Apollo (public / private / overdue / done) - a spread of visibilities
  await mkTask(P.Apollo, 'pub-overdue', { dueDate: day('2026-11-02') });
  await mkTask(P.Apollo, 'pub-today', { dueDate: day('2026-11-14'), assignees: [users.contributor._id] });
  await mkTask(P.Apollo, 'pub-none', { assignees: [users.member._id, users.contributor._id] });
  await mkTask(P.Apollo, 'pub-done', { dueDate: day('2026-11-01'), status: 'Completed' });
  await mkTask(P.Apollo, 'priv-member', { visibility: 'Private', assignees: [users.member._id], dueDate: day('2026-11-05') });
  await mkTask(P.Apollo, 'priv-unattached', { visibility: 'Private', assignees: [users.contributor._id], dueDate: day('2026-11-06'), approvers: [] });
  await mkTask(P.Apollo, 'priv-approver', { visibility: 'Private', assignees: [], approvers: [users.contributor._id], dueDate: day('2026-11-07') });
  await mkTask(P.Skunkworks, 'skunk-task', { dueDate: day('2026-11-03') });
  await mkTask(P.Zephyr, 'zeph-task', { dueDate: day('2026-11-30') });
});

describe('list_projects', () => {
  test('arguments are strict', () => {
    const parse = (i) => T.projects.schema.safeParse(i).success;
    expect(parse({})).toBe(true);
    expect(parse({ status: 'Active', overdue: true, name_contains: 'a', sort: 'open_tasks', limit: 20 })).toBe(true);
    for (const bad of [{ status: 'Archived' }, { status: 'whatever' }, { overdue: 'yes' }, { name_contains: '' }, { name_contains: 'x'.repeat(61) }, { name_contains: { $ne: 1 } }, { sort: 'name' }, { limit: 21 }, { organization: 'x' }, { project: 'x' }, { filter: {} }]) {
      expect({ bad, ok: parse(bad) }).toEqual({ bad, ok: false });
    }
  });

  test('visibility per role: private only for owner/members (administrators and HR do NOT see it), team-visible for that team and admins, archived and deleted never', async () => {
    const seen = async (key) => names(await run(T.projects, users[key], { limit: 20 })).sort();
    expect(await seen('owner')).toEqual(['Apollo', 'Apollo Legacy', 'Gemini', 'Gemini', 'Gemini', 'Skunkworks', 'TeamProj', 'Zephyr'].sort());
    expect(await seen('admin')).toEqual(['Apollo', 'Apollo Legacy', 'Gemini', 'Gemini', 'TeamProj', 'Zephyr']); // no Skunkworks, no private Gemini
    expect(await seen('coadmin')).toEqual(await seen('admin'));
    expect(await seen('hr')).toEqual(['Apollo', 'Apollo Legacy', 'Gemini', 'Gemini', 'Zephyr']);
    expect(await seen('outsider')).toEqual(['Apollo', 'Apollo Legacy', 'Gemini', 'Gemini', 'Zephyr']);
    expect(await seen('teamEmp')).toContain('TeamProj');
    expect(await seen('manager')).toContain('TeamProj'); // on that team
    expect(await seen('lonelyManager')).not.toContain('TeamProj');
    expect(await seen('member')).toEqual(expect.arrayContaining(['Skunkworks', 'Gemini']));
    expect((await seen('member')).filter((n) => n === 'Gemini')).toHaveLength(3);
    for (const key of ['owner', 'admin', 'member']) expect(await seen(key)).not.toEqual(expect.arrayContaining(['ArchivedProj', 'DeletedProj']));
    expect((await run(T.projects, users.guest)).data).toEqual([]);
    expect((await run(T.projects, users.blocked)).data).toEqual([]);
  });

  test('cross-organization: another organization\'s admin sees only its own projects', async () => {
    const r = await run(T.projects, users.adminB, { limit: 20 });
    expect(r.data.map((p) => p.id)).toEqual([String(P.ApolloB._id)]);
    expect(JSON.stringify(r)).not.toMatch(/Zephyr|Skunkworks|Gemini/);
  });

  test('status, overdue and "all"', async () => {
    expect(names(await run(T.projects, users.owner, { status: 'Planning', limit: 20 })).sort()).toEqual(['Gemini', 'Zephyr']);
    expect(names(await run(T.projects, users.owner, { status: 'Completed' }))).toEqual(['Apollo Legacy']);
    const late = await run(T.projects, users.owner, { overdue: true, limit: 20 });
    expect(names(late)).toEqual(['Apollo', 'Skunkworks']); // running projects past their due date, soonest due first; Apollo Legacy is Completed so never "overdue"
    expect(late.data.every((p) => p.pastDue === true)).toBe(true);
    expect(names(await run(T.projects, users.owner, { overdue: false, limit: 20 }))).not.toContain('Apollo');
    expect((await run(T.projects, users.owner, { status: 'all', limit: 20 })).summary.total).toBe(8);
    expect((await run(T.projects, users.admin, { overdue: true })).data.map((p) => p.name)).toEqual(['Apollo']); // admin: not the private one
  });

  test('name_contains is a LITERAL, case-insensitive substring; regex syntax and injection attempts match nothing and cannot hang', async () => {
    expect(names(await run(T.projects, users.owner, { name_contains: 'apol', limit: 20 })).sort()).toEqual(['Apollo', 'Apollo Legacy']);
    for (const attack of ['.*', '.+', '^Apollo$', '(a+)+$', '[a-z]+', '\\', '(', 'Apollo|Zephyr', '$', '(?i)apollo', 'a{1,999999}', '\\d']) {
      const started = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const r = await run(T.projects, users.owner, { name_contains: attack, limit: 20 });
      expect({ attack, found: r.data.length }).toEqual({ attack, found: 0 });
      expect(Date.now() - started).toBeLessThan(2000);
    }
    await Project.create({ organization: orgA._id, createdBy: users.owner._id, owner: users.owner._id, slug: 'dot', name: 'R&D (v2.0) [beta]', visibility: 'Organization' });
    expect(names(await run(T.projects, users.owner, { name_contains: '(v2.0) [beta]' }))).toEqual(['R&D (v2.0) [beta]']); // metacharacters match themselves
    expect(names(await run(T.projects, users.owner, { name_contains: 'v2x0' }))).toEqual([]); // "." is not a wildcard
  });

  test('sorting is deterministic with a stable tie-breaker (name, then id), for every sort key, on repeated runs', async () => {
    for (const sort of ['due', 'open_tasks', 'overdue_tasks']) {
      const first = (await run(T.projects, users.owner, { sort, limit: 20 })).data.map((p) => p.id);
      for (let i = 0; i < 3; i += 1) expect((await run(T.projects, users.owner, { sort, limit: 20 })).data.map((p) => p.id)).toEqual(first);
    }
    const byDue = (await run(T.projects, users.owner, { sort: 'due', limit: 20 })).data;
    expect(byDue.map((p) => p.name).slice(0, 4)).toEqual(['Apollo Legacy', 'Apollo', 'Skunkworks', 'Zephyr']); // soonest due first; projects without a due date last
    const undated = byDue.filter((p) => p.due === null);
    expect(undated.map((p) => p.name)).toEqual([...undated.map((p) => p.name)].sort((a, b) => a.localeCompare(b)));
    const geminis = byDue.filter((p) => p.name === 'Gemini').map((p) => p.id);
    expect(geminis).toEqual([...geminis].sort()); // same name, same (no) due date: ordered by id
    const open = await run(T.projects, users.owner, { sort: 'open_tasks', limit: 20 });
    expect(open.data.map((p) => p.openTasks)).toEqual([...open.data.map((p) => p.openTasks)].sort((a, b) => b - a));
    expect(open.data[0].name).toBe('Apollo');
    const overdue = await run(T.projects, users.owner, { sort: 'overdue_tasks', limit: 20 });
    expect(overdue.data.map((p) => p.overdueTasks)).toEqual([...overdue.data.map((p) => p.overdueTasks)].sort((a, b) => b - a));
  });

  test('task counts include ONLY tasks the user may see, and equal list_project_tasks totals for the same project', async () => {
    const count = async (key) => (await run(T.projects, users[key], { name_contains: 'Apollo', status: 'Active' })).data[0];
    // Apollo open tasks: pub-overdue, pub-today, pub-none (public) + priv-member, priv-unattached, priv-approver (private)
    expect(await count('owner')).toMatchObject({ openTasks: 6, overdueTasks: 4 }); // owner of the project sees all: overdue = pub-overdue, priv-member, priv-unattached, priv-approver
    expect(await count('projectMgr')).toMatchObject({ openTasks: 6, overdueTasks: 4 });
    expect(await count('member')).toMatchObject({ openTasks: 4, overdueTasks: 2 }); // 3 public + own private
    expect(await count('contributor')).toMatchObject({ openTasks: 5, overdueTasks: 3 }); // 3 public + private assigned + private approver
    expect(await count('admin')).toMatchObject({ openTasks: 3, overdueTasks: 1 }); // public only: NO private tasks, not even as a count
    expect(await count('outsider')).toMatchObject({ openTasks: 0, overdueTasks: 0 }); // can see the project, is not a member: sees no tasks
    for (const key of ['owner', 'projectMgr', 'member', 'contributor', 'admin', 'outsider', 'hr']) {
      const listed = (await run(T.projects, users[key], { name_contains: 'Apollo', status: 'Active' })).data[0];
      if (!listed) continue; // eslint-disable-line no-continue
      const open = await run(T.tasks, users[key], { project: String(P.Apollo._id), status: 'open', limit: 20 });
      const late = await run(T.tasks, users[key], { project: String(P.Apollo._id), due: 'overdue', limit: 20 });
      expect({ key, open: listed.openTasks, late: listed.overdueTasks }).toEqual({ key, open: open.summary.total, late: late.summary.total });
    }
  });

  test('visible-project cap: the result says it may not cover every project', async () => {
    const real = aiScope.resolveAiScope;
    const spy = jest.spyOn(aiScope, 'resolveAiScope').mockImplementation(async (...a) => ({ ...(await real(...a)), truncated: true }));
    try {
      expect((await run(T.projects, users.owner)).summary.complete).toBe(false);
      expect((await run(T.projects, users.outsider)).summary.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((await run(T.projects, users.owner)).summary.complete).toBe(true);
  });

  test('projection: no description, client, budget, link or email; owner is a name; rows are flat', async () => {
    const r = await run(T.projects, users.owner, { name_contains: 'Apollo', status: 'Active' });
    expect(Object.keys(r.data[0]).sort()).toEqual(['due', 'href', 'id', 'memberCount', 'name', 'openTasks', 'overdueTasks', 'owner', 'pastDue', 'priority', 'start', 'status', 'type']);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|777777|secret\.example|@|description|client|budget/i);
    expect(r.data[0]).toMatchObject({ owner: 'Owner Tester', memberCount: 6, href: `/dashboard/projects/${P.Apollo._id}` });
  });

  test('limit bounds the rows, total is the full match count and `truncated` says so', async () => {
    const r = await run(T.projects, users.owner, { limit: 3 });
    expect(r.data).toHaveLength(3);
    expect(r.summary).toMatchObject({ count: 3, total: 8, truncated: true });
  });
});

describe('get_project_overview', () => {
  const overview = (actor, project) => run(T.overview, actor, { project });
  const strip = (r) => ({ ...r, asOf: undefined });

  test('arguments are strict', () => {
    expect(T.overview.schema.safeParse({ project: 'Apollo' }).success).toBe(true);
    for (const bad of [{}, { project: '' }, { project: 'x'.repeat(121) }, { project: { $ne: null } }, { project: 'a', extra: 1 }, { id: 'x' }, { project: 5 }]) expect(T.overview.schema.safeParse(bad).success).toBe(false);
  });

  test('by id, by exact name (case-insensitive), and exact is PREFERRED over a longer partial match', async () => {
    const byId = await overview(users.owner, String(P.Apollo._id));
    expect(byId).toMatchObject({ outcome: 'found', matchedBy: 'id', candidates: [], project: { name: 'Apollo', status: 'Active', priority: 'High', type: 'Technical', owner: 'Owner Tester', due: '2026-11-10', pastDue: true, memberCount: 6 } });
    const byName = await overview(users.owner, 'apollo');
    expect(byName).toMatchObject({ outcome: 'found', matchedBy: 'exact_name', project: { name: 'Apollo' } }); // not ambiguous with "Apollo Legacy"
    expect((await overview(users.owner, '  APOLLO   ')).matchedBy).toBe('exact_name');
  });

  test('a unique PARTIAL match is returned and labelled; several partial matches are ambiguous', async () => {
    expect(await overview(users.owner, 'Zeph')).toMatchObject({ outcome: 'found', matchedBy: 'partial_name', project: { name: 'Zephyr' } });
    const many = await overview(users.owner, 'Apol'); // Apollo and Apollo Legacy: neither is exact
    expect(many).toMatchObject({ outcome: 'ambiguous', project: null, taskStatusCounts: null });
    expect(many.candidates.map((c) => c.name).sort()).toEqual(['Apollo', 'Apollo Legacy']);
  });

  test('identical exact names: ambiguity with SAFE candidates taken only from what the user can see', async () => {
    const outsider = await overview(users.outsider, 'Gemini');
    expect(outsider.outcome).toBe('ambiguous');
    expect(outsider.candidates).toHaveLength(2);
    expect(outsider.candidates.map((c) => c.id)).not.toContain(String(P.GeminiPrivate._id));
    expect(Object.keys(outsider.candidates[0]).sort()).toEqual(['due', 'id', 'name', 'owner', 'status']);
    expect((await overview(users.member, 'Gemini')).candidates).toHaveLength(3); // the member may see the private one too
    expect((await overview(users.admin, 'Gemini')).candidates.map((c) => c.id)).not.toContain(String(P.GeminiPrivate._id)); // no administrator bypass
  });

  test('missing, malformed, inaccessible and other-organization references are INDISTINGUISHABLE', async () => {
    const missing = strip(await overview(users.admin, String(oid())));
    expect(missing).toMatchObject({ outcome: 'not_found', matchedBy: null, project: null, candidates: [], taskStatusCounts: null });
    for (const ref of ['not-an-id', '$ne', String(P.Skunkworks._id), 'Skunkworks', 'skunk', String(P.ApolloB._id), String(P.ArchivedProj._id), String(P.DeletedProj._id), 'ArchivedProj', 'No Such Project']) {
      // eslint-disable-next-line no-await-in-loop
      expect({ ref, result: strip(await overview(users.admin, ref)) }).toEqual({ ref, result: missing });
    }
    expect(strip(await overview(users.outsider, String(P.Skunkworks._id)))).toEqual(missing);
    expect(strip(await overview(users.adminB, String(P.Apollo._id)))).toEqual(missing); // org B asking for org A's project
  });

  test('private project: only owner / members; an administrator gets "not found" by id AND by name', async () => {
    expect((await overview(users.member, 'Skunkworks')).outcome).toBe('found');
    expect((await overview(users.projectMgr, String(P.Skunkworks._id))).outcome).toBe('found');
    for (const key of ['admin', 'coadmin', 'hr', 'manager', 'outsider']) {
      expect({ key, o: (await overview(users[key], String(P.Skunkworks._id))).outcome }).toEqual({ key, o: 'not_found' });
      expect({ key, o: (await overview(users[key], 'Skunkworks')).outcome }).toEqual({ key, o: 'not_found' });
    }
  });

  test('task counts by status are role-specific and never include hidden tasks; no description / client / budget / link', async () => {
    const owner = await overview(users.owner, 'Apollo');
    expect(owner.taskStatusCounts).toEqual({ todo: 6, inProgress: 0, inReview: 0, completed: 1, cancelled: 0, overdue: 4 });
    expect((await overview(users.admin, 'Apollo')).taskStatusCounts).toEqual({ todo: 3, inProgress: 0, inReview: 0, completed: 1, cancelled: 0, overdue: 1 });
    expect((await overview(users.outsider, 'Apollo')).taskStatusCounts).toEqual({ todo: 0, inProgress: 0, inReview: 0, completed: 0, cancelled: 0, overdue: 0 });
    expect(JSON.stringify(owner)).not.toMatch(/SECRET|777777|secret\.example|description|client|budget|@/i);
  });
});

describe('list_project_members', () => {
  const members = (actor, project) => run(T.members, actor, { project });

  test('the owner appears ONCE with the project role Owner (even if also listed in members); roles come from the project, in a fixed order; blocked and deactivated people are absent', async () => {
    const r = await members(users.member, 'Apollo');
    expect(r.data.map((m) => [m.name, m.projectRole])).toEqual([['Owner Tester', 'Owner'], ['ProjectMgr Tester', 'Manager'], ['Member Tester', 'Contributor'], ['Contributor Tester', 'Viewer']]);
    expect(r.summary).toMatchObject({ count: 4, total: 4, truncated: false, complete: true });
    expect(JSON.stringify(r)).not.toMatch(/Blocked|Inactive/);
    expect(r.project).toEqual({ id: String(P.Apollo._id), name: 'Apollo' });
  });

  test('a person listed twice appears once; roles are NOT inferred from organization roles (an org-admin listed as Viewer is a Viewer)', async () => {
    await Project.updateOne({ _id: P.Apollo._id }, { $push: { members: { $each: [{ user: users.member._id, role: 'Manager' }, { user: users.admin._id, role: 'Viewer' }, { user: users.hr._id, role: 'Contributor' }] } } });
    const r = await members(users.member, 'Apollo');
    expect(r.data.filter((m) => m.name === 'Member Tester')).toHaveLength(1);
    expect(r.data.find((m) => m.name === 'Admin Tester').projectRole).toBe('Viewer');
    expect(r.data.find((m) => m.name === 'Hr Tester').projectRole).toBe('Contributor');
  });

  test('people who are not members never appear; sensitive fields are never present', async () => {
    const r = await members(users.outsider, 'Apollo');
    expect(JSON.stringify(r)).not.toMatch(/Outsider|TeamEmp|Manager Tester|@|email|phone|passwordHash|skills|presence/);
    expect(Object.keys(r.data[0]).sort()).toEqual(['id', 'name', 'projectRole']);
  });

  test('more than 50 members: 50 are shown, the true total is reported, and it is flagged truncated', async () => {
    const extra = await User.insertMany(Array.from({ length: 70 }, (_, i) => ({ organization: orgA._id, firstName: `Extra${String(i).padStart(2, '0')}`, lastName: 'Person', email: `extra${i}@acme.test`, passwordHash: 'x', role: 'employee', isActive: true, emailVerified: true, skills: [] })));
    await Project.updateOne({ _id: P.Zephyr._id }, { $push: { members: { $each: extra.map((u) => ({ user: u._id, role: 'Viewer' })) } } });
    const r = await members(users.owner, 'Zephyr');
    expect(r.data).toHaveLength(50);
    expect(r.summary).toMatchObject({ count: 50, total: 72, truncated: true, complete: true });
    expect(new Set(r.data.map((m) => m.id)).size).toBe(50);
  });

  test('a roster too large to examine is reported as incomplete', async () => {
    const extra = await User.insertMany(Array.from({ length: 310 }, (_, i) => ({ organization: orgA._id, firstName: `Bulk${i}`, lastName: 'Person', email: `bulk${i}@acme.test`, passwordHash: 'x', role: 'employee', isActive: true, emailVerified: true, skills: [] })));
    await Project.updateOne({ _id: P.Zephyr._id }, { $push: { members: { $each: extra.map((u) => ({ user: u._id, role: 'Viewer' })) } } });
    const r = await members(users.owner, 'Zephyr');
    expect(r.summary).toMatchObject({ truncated: true, complete: false });
  });

  test('ambiguous names return safe candidates; unknown / private / foreign projects are one "not found"', async () => {
    expect((await members(users.outsider, 'Gemini')).candidates).toHaveLength(2);
    const missing = await members(users.admin, String(oid()));
    for (const ref of [String(P.Skunkworks._id), 'Skunkworks', String(P.ApolloB._id), 'nope']) expect(await members(users.admin, ref)).toEqual(missing);
    expect(missing).toMatchObject({ outcome: 'not_found', project: null, data: [] });
    expect((await members(users.member, 'Skunkworks')).outcome).toBe('found');
  });
});

describe('list_project_tasks', () => {
  const tasks = (actor, input) => run(T.tasks, actor, { project: String(P.Apollo._id), limit: 20, ...input });

  test('arguments are strict', () => {
    const parse = (i) => T.tasks.schema.safeParse(i).success;
    expect(parse({ project: 'Apollo', status: 'all', due: 'overdue', assignee: 'me', limit: 20 })).toBe(true);
    for (const bad of [{}, { project: 'A', status: 'bogus' }, { project: 'A', due: 'tomorrow' }, { project: 'A', assignee: 'u1' }, { project: 'A', assignee: String(oid()) }, { project: 'A', limit: 21 }, { project: 'A', user: 'x' }, { project: 'A', filter: {} }]) expect({ bad, ok: parse(bad) }).toEqual({ bad, ok: false });
  });

  test('who sees which tasks: manager/owner all; assignee and approver their private ones; unrelated members and ADMINS no private tasks; a non-member nothing', async () => {
    const seen = async (key, input) => names(await tasks(users[key], { status: 'all', ...input })).sort();
    const all = ['pub-done', 'pub-none', 'pub-overdue', 'pub-today', 'priv-approver', 'priv-member', 'priv-unattached'];
    expect(await seen('owner')).toEqual([...all].sort());
    expect(await seen('projectMgr')).toEqual([...all].sort());
    expect(await seen('member')).toEqual(['priv-member', 'pub-done', 'pub-none', 'pub-overdue', 'pub-today']);
    expect(await seen('contributor')).toEqual(['priv-approver', 'priv-unattached', 'pub-done', 'pub-none', 'pub-overdue', 'pub-today']);
    expect(await seen('admin')).toEqual(['pub-done', 'pub-none', 'pub-overdue', 'pub-today']); // public only
    expect(await seen('coadmin')).toEqual(await seen('admin'));
    for (const key of ['outsider', 'hr', 'manager', 'teamEmp']) expect(await seen(key)).toEqual([]);
    for (const key of ['guest', 'blocked']) expect((await tasks(users[key])).outcome).toBe('not_found');
  });

  test('status and due use Step 3 semantics (open default, overdue = open + strictly before today, today is not overdue, this_week Mon-Sun)', async () => {
    expect(names(await tasks(users.owner))).not.toContain('pub-done'); // default status: open
    expect(names(await tasks(users.owner, { status: 'Completed' }))).toEqual(['pub-done']);
    expect(names(await tasks(users.owner, { due: 'overdue' })).sort()).toEqual(['priv-approver', 'priv-member', 'priv-unattached', 'pub-overdue']);
    expect(names(await tasks(users.owner, { due: 'today' }))).toEqual(['pub-today']);
    expect(names(await tasks(users.owner, { due: 'none' }))).toEqual(['pub-none']);
    expect(names(await tasks(users.owner, { due: 'this_week', status: 'all' }))).toEqual(['pub-today']); // Mon 9th - Sun 15th: only the 14th
    expect((await tasks(users.owner, { status: 'Completed', due: 'overdue' })).data).toEqual([]);
    const r = await tasks(users.owner, { due: 'overdue' });
    expect(r.data.every((t) => t.overdue === true)).toBe(true);
    expect(r.asOf).toEqual({ date: '2026-11-14', timeZone: 'Asia/Kolkata' });
  });

  test('assignee "me" is the authenticated user; "any" still respects visibility', async () => {
    expect(names(await tasks(users.member, { assignee: 'me', status: 'all' })).sort()).toEqual(['priv-member', 'pub-done', 'pub-none', 'pub-overdue']);
    expect(names(await tasks(users.contributor, { assignee: 'me' })).sort()).toEqual(['priv-unattached', 'pub-none', 'pub-today']);
    expect(names(await tasks(users.admin, { assignee: 'me' }))).toEqual([]); // assigned to nobody
    expect(names(await tasks(users.admin, { assignee: 'any' })).sort()).toEqual(['pub-none', 'pub-overdue', 'pub-today']);
  });

  test('COUNTS AND ROWS USE ONE RULE: the total equals what an independent per-record check of every task allows', async () => {
    const project = await Project.findById(P.Apollo._id).lean();
    const all = await Task.find({ project: P.Apollo._id }).lean();
    for (const key of ['owner', 'projectMgr', 'member', 'contributor', 'admin', 'coadmin', 'hr', 'outsider', 'teamEmp', 'manager']) {
      const expected = all.filter((t) => A.canAiViewTask(users[key], project, t) && ['Todo', 'In Progress', 'In Review'].includes(t.status)).map((t) => t.title).sort();
      // eslint-disable-next-line no-await-in-loop
      const r = await tasks(users[key]);
      expect({ key, rows: names(r).sort(), total: r.summary.total }).toEqual({ key, rows: expected, total: expected.length });
    }
  });

  test('private project: members see its tasks; an administrator gets "not found"', async () => {
    const skunk = (actor) => run(T.tasks, actor, { project: 'Skunkworks' });
    expect(names(await skunk(users.member))).toEqual(['skunk-task']);
    expect((await skunk(users.admin)).outcome).toBe('not_found');
    expect((await skunk(users.outsider))).toEqual(await skunk(users.admin));
  });

  test('project references: by name, ambiguity with safe candidates, other organization = not found', async () => {
    expect((await run(T.tasks, users.owner, { project: 'apollo' })).project.name).toBe('Apollo');
    const amb = await run(T.tasks, users.outsider, { project: 'Gemini' });
    expect(amb).toMatchObject({ outcome: 'ambiguous', data: [], filters: null });
    expect(amb.candidates).toHaveLength(2);
    expect((await run(T.tasks, users.adminB, { project: String(P.Apollo._id) })).outcome).toBe('not_found');
    const foreign = await run(T.tasks, users.admin, { project: String(P.ApolloB._id) });
    expect(foreign).toEqual(await run(T.tasks, users.admin, { project: String(oid()) }));
  });

  test('no sensitive task fields; flat rows; links to the task; assignee names only', async () => {
    await Task.updateOne({ title: 'pub-none' }, { description: 'SECRET-DESCRIPTION', checklist: [{ text: 'SECRET-CHECK', addedBy: users.owner._id }], labels: ['SECRET-LABEL'] });
    const r = await tasks(users.owner);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|@|description|checklist/);
    expect(Object.keys(r.data[0]).sort()).toEqual(['assigneeCount', 'assignees', 'due', 'href', 'id', 'overdue', 'priority', 'projectId', 'projectName', 'status', 'title']);
  });

  test('limit and the byte budget: whole rows, flagged truncated', async () => {
    await Task.insertMany(Array.from({ length: 20 }, (_, i) => ({ organization: orgA._id, project: P.Apollo._id, title: `${i}-${'T'.repeat(150)}`, owner: users.owner._id, createdBy: users.owner._id, assignees: [users.member._id], dueDate: day('2026-12-24') })));
    const r = await tasks(users.owner);
    expect(r.summary.truncated).toBe(true);
    expect(r.summary.total).toBeGreaterThan(r.summary.count);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(LIMITS.maxResultBytes);
    expect((await tasks(users.owner, { limit: 2 })).data).toHaveLength(2);
  });

  test('queries carry the deadline, an aborted signal stops further queries, a time-limit error is the fixed timeout', async () => {
    const seen = [];
    const original = mongoose.Query.prototype.exec;
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function exec(...a) { seen.push({ model: this.model.modelName, ms: this.options.maxTimeMS }); return original.apply(this, a); });
    try {
      await run(T.tasks, users.owner, { project: 'Apollo' }, { maxTimeMs: 3579 });
      expect(seen.filter((q) => ['Project', 'Task', 'User'].includes(q.model)).every((q) => q.ms === 3579)).toBe(true);
      const mid = new AbortController();
      const queries = [];
      spy.mockImplementation(function exec(...a) { queries.push(this.model.modelName); const r = original.apply(this, a); return this.model.modelName === 'Project' ? r.then((rows) => { mid.abort(); return rows; }) : r; });
      await expect(run(T.tasks, users.owner, { project: String(P.Apollo._id) }, { signal: mid.signal })).rejects.toMatchObject({ code: 'AI_TOOL_ABORTED' });
      expect(queries).not.toContain('Task');
    } finally {
      spy.mockRestore();
    }
    const failing = jest.spyOn(Task, 'countDocuments').mockImplementation(() => ({ maxTimeMS: () => Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 })) }));
    try {
      await expect(run(T.tasks, users.owner, { project: String(P.Apollo._id) })).rejects.toMatchObject({ code: 'AI_TOOL_TIMEOUT' });
    } finally {
      failing.mockRestore();
    }
  });
});

describe('get_team', () => {
  const team = (actor, input = {}) => run(T.team, actor, input);

  test('arguments are strict', () => {
    expect(T.team.schema.safeParse({}).success).toBe(true);
    expect(T.team.schema.safeParse({ team: 'Platform' }).success).toBe(true);
    for (const bad of [{ team: '' }, { team: 'x'.repeat(121) }, { team: { $ne: 1 } }, { team: 'a', extra: 1 }, { name: 'x' }]) expect(T.team.schema.safeParse(bad).success).toBe(false);
  });

  test('LIST visibility: admin and HR see every team; others only teams they lead or belong to; a manager with no team gets none; rows never carry member names', async () => {
    const list = async (key) => { const r = await team(users[key]); return { names: r.teams.map((t) => t.name), hasMembers: r.teams.some((t) => 'members' in t) }; };
    expect((await list('admin')).names).toEqual(['Platform', 'Platform Ops', 'Sales']);
    expect((await list('coadmin')).names).toEqual(['Platform', 'Platform Ops', 'Sales']);
    expect((await list('hr')).names).toEqual(['Platform', 'Platform Ops', 'Sales']);
    expect((await list('manager')).names).toEqual(['Platform']); // leads Platform only: NOT organization-wide
    expect((await list('lonelyManager')).names).toEqual([]);
    expect((await list('teamEmp')).names).toEqual(['Platform']);
    expect((await list('outsider')).names).toEqual(['Sales']);
    expect((await list('member')).names).toEqual(['Platform Ops']);
    expect((await list('guest')).names).toEqual([]);
    for (const key of ['admin', 'hr', 'manager']) expect((await list(key)).hasMembers).toBe(false);
    expect((await team(users.admin)).outcome).toBe('list');
  });

  test('DETAIL: lead, active member count and active member names; blocked and deactivated people are neither named nor counted', async () => {
    const r = await team(users.teamEmp, { team: 'Platform' });
    expect(r).toMatchObject({ outcome: 'found', matchedBy: 'exact_name', team: { name: 'Platform', lead: 'Manager Tester', memberCount: 1, members: ['TeamEmp Tester'] } });
    expect(JSON.stringify(r)).not.toMatch(/Blocked|Inactive|SECRET|@/);
    const ops = await team(users.admin, { team: 'Platform Ops' });
    expect(ops.team.lead).toBeNull(); // the lead is deactivated: not named
    expect(ops.team.members).toEqual(['Member Tester']);
  });

  test('a manager sees the team they lead, NOT other teams: those are indistinguishable from missing', async () => {
    expect((await team(users.manager, { team: String(team1._id) })).outcome).toBe('found');
    const missing = await team(users.manager, { team: String(oid()) });
    expect(missing).toMatchObject({ outcome: 'not_found', teams: [], team: null, candidates: [] });
    for (const ref of [String(team2._id), 'Sales', 'sal', 'not-an-id', '$ne']) expect({ ref, r: await team(users.manager, { team: ref }) }).toEqual({ ref, r: missing });
    expect(await team(users.outsider, { team: String(team1._id) })).toEqual(missing);
    expect(await team(users.adminB, { team: String(team1._id) })).toEqual(missing);
    expect((await team(users.hr, { team: String(team2._id) })).outcome).toBe('found'); // HR may see any team
  });

  test('names: exact preferred; several partial matches are ambiguous with candidates only from the visible set', async () => {
    expect((await team(users.admin, { team: 'platform' })).matchedBy).toBe('exact_name'); // "Platform" exactly, not "Platform Ops"
    const amb = await team(users.admin, { team: 'Platf' });
    expect(amb).toMatchObject({ outcome: 'ambiguous', team: null });
    expect(amb.candidates.map((c) => c.name).sort()).toEqual(['Platform', 'Platform Ops']);
    expect((await team(users.outsider, { team: 'Platf' })).outcome).toBe('not_found'); // no inaccessible team name is revealed
    expect((await team(users.teamEmp, { team: 'Platf' })).matchedBy).toBe('partial_name'); // only one visible match
  });

  test('regex metacharacters in a team name match literally and never widen the search', async () => {
    for (const attack of ['.*', '^Platform$', '(a+)+$', '[a-z]+', 'Platform|Sales']) expect((await team(users.admin, { team: attack })).outcome).toBe('not_found');
  });

  test('more than 50 members: 50 names, the true count and a truncated flag; no contact details', async () => {
    const extra = await User.insertMany(Array.from({ length: 70 }, (_, i) => ({ organization: orgA._id, firstName: `Big${String(i).padStart(2, '0')}`, lastName: 'Member', email: `big${i}@acme.test`, passwordHash: 'x', role: 'employee', isActive: true, emailVerified: true, skills: [] })));
    await Team.updateOne({ _id: team2._id }, { members: extra.map((u) => u._id) });
    const r = await team(users.admin, { team: 'Sales' });
    expect(r.team.members).toHaveLength(50);
    expect(r.team.memberCount).toBe(70);
    expect(r.summary).toMatchObject({ truncated: true, complete: true });
    expect(JSON.stringify(r)).not.toMatch(/@|email|phone/);
  });

  test('another organization\'s admin sees none of this organization\'s teams', async () => {
    const r = await team(users.adminB);
    expect(r.teams).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/Platform|Sales/);
  });
});
