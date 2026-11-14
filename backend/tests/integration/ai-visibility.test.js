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
 * Phase 8, Step 2: AI-specific visibility. The Mongo filters and the pure predicates are checked AGAINST EACH OTHER over every
 * role x every record, then the policy itself (no administrator bypass of private resources) and the product's own, unchanged
 * access rules are checked explicitly.
 */
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const Meeting = require('../../src/models/Meeting');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const A = require('../../src/utils/aiAccess');
const productProject = require('../../src/utils/projectAccess');
const productTask = require('../../src/utils/taskAccess');
const productMeeting = require('../../src/utils/meetingAccess');
const productTeam = require('../../src/utils/teamAccess');
const productPeople = require('../../src/utils/peopleAccess');
const scope = require('../../src/services/ai/tools/aiScope');

const { users, createUser } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const ACTORS = ['admin', 'coadmin', 'hr', 'manager', 'owner', 'member', 'contributor', 'projectMgr', 'teamEmp', 'outsider', 'guest', 'blocked', 'inactive'];
let orgA; let orgB; let team1; let team2;
const P = {}; const T = {}; const M = {};

const mkProject = (key, over) => Project.create({ organization: orgA._id, createdBy: users.owner._id, slug: key, name: key, owner: users.owner._id, ...over }).then((doc) => { P[key] = doc; return doc; });
const mkTask = (key, project, over = {}) => Task.create({ organization: orgA._id, project: project._id, title: key, owner: users.owner._id, createdBy: users.owner._id, ...over }).then((doc) => { T[key] = doc; return doc; });
const mkMeeting = (key, project, over = {}) => Meeting.create({ organization: orgA._id, project: project._id, topic: key, type: 'Scheduled', startTime: new Date(Date.now() + 86400000), host: users.owner._id, createdBy: users.owner._id, participants: [], ...over }).then((doc) => { M[key] = doc; return doc; });

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
  await Promise.all([Meeting, Organization, Project, Task, Team, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  team1 = await Team.create({ organization: orgA._id, name: 'Platform', createdBy: oid() });
  team2 = await Team.create({ organization: orgA._id, name: 'Sales', createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'coadmin', ROLES.ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
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
  await Team.updateOne({ _id: team1._id }, { lead: users.manager._id, members: [users.teamEmp._id] });

  const roster = [{ user: users.member._id, role: 'Contributor' }, { user: users.contributor._id, role: 'Viewer' }, { user: users.projectMgr._id, role: 'Manager' }];
  await mkProject('orgVisible', { visibility: 'Organization', members: roster });
  await mkProject('teamVisible', { visibility: 'Team', team: team1._id, members: [] });
  await mkProject('private', { visibility: 'Private', members: roster });
  await mkProject('archivedPrivate', { visibility: 'Organization', archived: true, members: roster });
  await mkProject('deleted', { visibility: 'Organization', deletedAt: new Date(), members: roster });

  await mkTask('pubInPrivate', P.private);
  await mkTask('privUnattached', P.private, { visibility: 'Private' });
  await mkTask('privAssignee', P.private, { visibility: 'Private', assignees: [users.member._id] });
  await mkTask('privApprover', P.private, { visibility: 'Private', approvers: [users.contributor._id] });
  await mkTask('pubInOrg', P.orgVisible);
  await mkTask('privInOrg', P.orgVisible, { visibility: 'Private' });
  await mkTask('assignedOutsider', P.private, { visibility: 'Private', assignees: [users.outsider._id] }); // assigned, but not a member of a private project
  await mkTask('pubInTeam', P.teamVisible);
  await mkTask('archivedTask', P.orgVisible, { archived: true });
  await mkTask('deletedTask', P.orgVisible, { deletedAt: new Date() });
  await mkTask('inArchivedProject', P.archivedPrivate);
  await mkTask('inDeletedProject', P.deleted);

  await mkMeeting('privateMeeting', P.private, { host: users.member._id, participants: [{ user: users.member._id }, { user: users.contributor._id }] });
  await mkMeeting('orgMeeting', P.orgVisible, { participants: [{ user: users.member._id }] });
  await mkMeeting('deletedMeeting', P.orgVisible, { deletedAt: new Date() });
});

const names = (docs) => docs.map((d) => d.name || d.title || d.topic).sort();
const projectIds = async (actor) => (await Project.find(A.buildAiProjectFilter(actor)).lean()).map((p) => p.name).sort();

describe('projects: AI visibility', () => {
  test('a member (any listed role) and the owner see the private project; everyone else does not - ADMINS INCLUDED', async () => {
    for (const key of ['owner', 'member', 'contributor', 'projectMgr']) expect(await projectIds(users[key])).toContain('private');
    for (const key of ['admin', 'coadmin', 'hr', 'manager', 'teamEmp', 'outsider']) expect(await projectIds(users[key])).not.toContain('private');
  });

  test('visibility is otherwise the product\'s: Organization to everyone, Team to that team (and admins), archived and deleted never', async () => {
    expect(await projectIds(users.outsider)).toEqual(['orgVisible']);
    expect(await projectIds(users.teamEmp)).toEqual(['orgVisible', 'teamVisible']);
    expect(await projectIds(users.admin)).toEqual(['orgVisible', 'teamVisible']); // ordinary read access to non-private projects is unchanged
    expect(await projectIds(users.hr)).toEqual(['orgVisible']);
    for (const key of ACTORS) {
      const seen = await projectIds(users[key]);
      expect(seen).not.toContain('archivedPrivate');
      expect(seen).not.toContain('deleted');
    }
    expect(await Project.countDocuments(A.buildAiProjectFilter(users.member, { includeArchived: true }))).toBe(3); // orgVisible, private, archived (deleted is never included)
  });

  test('guests, blocked and deactivated users match NOTHING; another organization\'s admin sees nothing of this organization', async () => {
    for (const key of ['guest', 'blocked', 'inactive']) {
      expect(await Project.countDocuments(A.buildAiProjectFilter(users[key]))).toBe(0);
      expect(A.canAiViewProject(users[key], P.orgVisible)).toBe(false);
    }
    expect(await Project.countDocuments(A.buildAiProjectFilter(users.adminB))).toBe(0);
    expect(A.canAiViewProject(users.adminB, P.orgVisible)).toBe(false);
    expect(A.canAiViewProject(null, P.orgVisible)).toBe(false);
    expect(A.canAiViewProject({ ...users.member.toObject(), organization: null }, P.orgVisible)).toBe(false);
  });

  test('PARITY: for every role and every project the Mongo filter and the predicate agree', async () => {
    const projects = await Project.find({}).lean();
    for (const key of ACTORS) {
      for (const project of projects) {
        const byFilter = Boolean(await Project.exists({ _id: project._id, ...A.buildAiProjectFilter(users[key]) }));
        expect({ key, project: project.name, allowed: A.canAiViewProject(users[key], project) }).toEqual({ key, project: project.name, allowed: byFilter });
      }
    }
  });

  test('membership is read from the data model: an owner who is NOT listed in `members` is still a member', async () => {
    expect(P.private.members.some((m) => String(m.user) === String(users.owner._id))).toBe(false);
    expect(A.projectRoleOf(users.owner, P.private)).toBe('Owner');
    expect(A.isAiProjectManager(users.owner, P.private)).toBe(true);
    expect(A.isAiProjectManager(users.projectMgr, P.private)).toBe(true);
    expect(A.isAiProjectManager(users.member, P.private)).toBe(false);
    expect(A.isAiProjectManager(users.admin, P.private)).toBe(false); // org admin status never makes anyone a project manager
  });
});

describe('product authorization is UNCHANGED (the AI rules are separate)', () => {
  test('administrators still see everything in the product: the stricter rule exists only in the AI helpers', async () => {
    expect(productProject.canViewProject(users.admin, P.private)).toBe(true);
    expect(productProject.canViewProject(users.coadmin, P.private)).toBe(true);
    expect(productProject.canManageProject(users.admin, P.private)).toBe(true);
    expect(productTask.canViewTask(users.admin, P.private, T.privUnattached)).toBe(true);
    expect(productMeeting.canViewMeeting(users.admin, P.private, M.privateMeeting)).toBe(true);
    expect(productProject.canViewProject(users.outsider, P.private)).toBe(false);
    // ... and the AI helpers say no to the very same calls
    expect(A.canAiViewProject(users.admin, P.private)).toBe(false);
    expect(A.canAiViewTask(users.admin, P.private, T.privUnattached)).toBe(false);
    expect(A.canAiViewMeeting(users.admin, P.private, M.privateMeeting)).toBe(false);
  });

  test('the AI rules never grant more than the product does (anything AI allows, the product allows)', async () => {
    const projects = await Project.find({}).lean();
    const tasks = await Task.find({}).lean();
    for (const key of ACTORS.filter((k) => !['blocked', 'inactive'].includes(k))) {
      for (const project of projects) {
        if (A.canAiViewProject(users[key], project, { includeArchived: true }) && key !== 'guest') expect(productProject.canViewProject(users[key], project)).toBe(true);
      }
      for (const task of tasks) {
        const project = projects.find((p) => String(p._id) === String(task.project));
        if (A.canAiViewTask(users[key], project, task, { includeArchived: true }) && key !== 'guest') expect(productTask.canViewTask(users[key], project, task)).toBe(true);
      }
    }
  });
});

describe('tasks: AI visibility', () => {
  const taskTitles = async (actor) => {
    const sc = await scope.resolveAiScope(actor);
    return (await Task.find(A.buildAiTaskFilter(actor, sc)).lean()).map((t) => t.title).sort();
  };

  test('private task: its assignee, its approver and the project manager/owner can see it; an unrelated member and ADMINS cannot', async () => {
    expect(await taskTitles(users.member)).toContain('privAssignee');
    expect(await taskTitles(users.contributor)).toContain('privApprover');
    expect(await taskTitles(users.projectMgr)).toEqual(expect.arrayContaining(['privUnattached', 'privAssignee', 'privApprover']));
    expect(await taskTitles(users.owner)).toEqual(expect.arrayContaining(['privUnattached', 'privAssignee', 'privApprover']));
    for (const key of ['member', 'contributor']) expect(await taskTitles(users[key])).not.toContain('privUnattached');
    for (const key of ['admin', 'coadmin', 'hr', 'manager', 'outsider']) {
      const seen = await taskTitles(users[key]);
      for (const hidden of ['privUnattached', 'privAssignee', 'privApprover', 'pubInPrivate', 'assignedOutsider']) expect(seen).not.toContain(hidden);
    }
  });

  test('a task is reachable only THROUGH a project the user can see: assigned-but-not-a-member of a private project is no access', async () => {
    expect(await taskTitles(users.outsider)).not.toContain('assignedOutsider');
    expect(A.canAiViewTask(users.outsider, P.private, T.assignedOutsider)).toBe(false);
    expect((await scope.findAiTask(users.outsider, String(T.assignedOutsider._id)))).toBeNull();
  });

  test('public tasks: project members; admins keep their ordinary read access to NON-private projects; others do not', async () => {
    expect(await taskTitles(users.member)).toEqual(expect.arrayContaining(['pubInPrivate', 'pubInOrg']));
    expect(await taskTitles(users.admin)).toEqual(['pubInOrg', 'pubInTeam']);
    expect(await taskTitles(users.outsider)).toEqual([]); // sees the Organization project, but is not a member of it
    expect(await taskTitles(users.admin)).not.toContain('privInOrg');
  });

  test('archived and deleted tasks, and tasks of archived or deleted projects, are excluded', async () => {
    for (const key of ['owner', 'member', 'admin']) {
      const seen = await taskTitles(users[key]);
      for (const gone of ['archivedTask', 'deletedTask', 'inArchivedProject', 'inDeletedProject']) expect(seen).not.toContain(gone);
    }
  });

  test('PARITY: for every role and every task the Mongo filter and the predicate agree', async () => {
    const projects = await Project.find({}).lean();
    const tasks = await Task.find({}).lean();
    for (const key of ACTORS) {
      const sc = await scope.resolveAiScope(users[key]);
      for (const task of tasks) {
        const project = projects.find((p) => String(p._id) === String(task.project));
        const byFilter = Boolean(await Task.exists({ _id: task._id, ...A.buildAiTaskFilter(users[key], sc) }));
        expect({ key, task: task.title, allowed: A.canAiViewTask(users[key], project, task) }).toEqual({ key, task: task.title, allowed: byFilter });
      }
    }
  });
});

describe('lookups by id: missing, malformed, foreign and forbidden are one and the same "not found"', () => {
  test('projects', async () => {
    expect((await scope.findAiProject(users.member, String(P.private._id)))._id).toEqual(P.private._id);
    const absent = [String(oid()), 'not-an-id', '$ne', '', null, undefined, 12345, String(P.deleted._id), String(P.archivedPrivate._id), String(P.private._id) /* for the outsider */];
    for (const id of absent.slice(0, -1)) expect(await scope.findAiProject(users.member, id)).toBeNull();
    expect(await scope.findAiProject(users.outsider, absent.at(-1))).toBeNull();
    expect(await scope.findAiProject(users.admin, String(P.private._id))).toBeNull(); // NO administrator bypass
    // another organization: the id is real there, and still just "not found"
    const foreign = await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'x', name: 'Globex secret', visibility: 'Organization' });
    expect(await scope.findAiProject(users.admin, String(foreign._id))).toBeNull();
    expect(await scope.findAiProject(users.adminB, String(foreign._id))).not.toBeNull();
  });

  test('tasks, meetings, teams and people', async () => {
    expect((await scope.findAiTask(users.member, String(T.privAssignee._id))).task._id).toEqual(T.privAssignee._id);
    for (const id of [String(oid()), 'nope', '$gt', String(T.deletedTask._id), String(T.archivedTask._id), String(T.privUnattached._id)]) expect(await scope.findAiTask(users.member, id)).toBeNull();
    expect(await scope.findAiTask(users.admin, String(T.privUnattached._id))).toBeNull();
    const foreignProject = await Project.create({ organization: orgB._id, createdBy: users.adminB._id, owner: users.adminB._id, slug: 'y', name: 'Globex', visibility: 'Organization' });
    const foreignTask = await Task.create({ organization: orgB._id, project: foreignProject._id, title: 'Globex task', owner: users.adminB._id, createdBy: users.adminB._id });
    expect(await scope.findAiTask(users.admin, String(foreignTask._id))).toBeNull();

    expect((await scope.findAiMeeting(users.member, String(M.privateMeeting._id))).meeting._id).toEqual(M.privateMeeting._id);
    expect(await scope.findAiMeeting(users.admin, String(M.privateMeeting._id))).toBeNull();
    expect(await scope.findAiMeeting(users.outsider, String(M.privateMeeting._id))).toBeNull();
    expect(await scope.findAiMeeting(users.member, String(M.deletedMeeting._id))).toBeNull();

    expect(await scope.findAiTeam(users.teamEmp, String(team1._id))).not.toBeNull();
    expect(await scope.findAiTeam(users.outsider, String(team1._id))).toBeNull(); // not their team
    expect(await scope.findAiTeam(users.hr, String(team1._id))).not.toBeNull(); // HR / admins see every team, as in the product
    expect(await scope.findAiTeam(users.manager, String(team2._id))).toBeNull(); // a manager is not an org-wide team administrator

    expect(await scope.findAiPerson(users.outsider, String(users.member._id))).not.toBeNull();
    for (const hidden of ['blocked', 'inactive', 'adminB']) expect(await scope.findAiPerson(users.admin, String(users[hidden]._id))).toBeNull(); // not even for admins
    expect(await scope.findAiPerson(users.guest, String(users.member._id))).toBeNull();
  });

  test('guests and blocked users are refused by every helper', async () => {
    for (const key of ['guest', 'blocked', 'inactive']) {
      expect(await scope.findAiProject(users[key], String(P.orgVisible._id))).toBeNull();
      expect(await scope.findAiTask(users[key], String(T.pubInOrg._id))).toBeNull();
      expect((await scope.resolveAiScope(users[key])).visibleProjectIds).toEqual([]);
    }
  });
});

describe('meetings, teams, people: visibility', () => {
  test('meetings: host / participant / project member through a visible project; admins not through a private one; PARITY with the filter', async () => {
    const projects = await Project.find({}).lean();
    const meetings = await Meeting.find({}).lean();
    for (const key of ACTORS) {
      const sc = await scope.resolveAiScope(users[key]);
      for (const meeting of meetings) {
        const project = projects.find((p) => String(p._id) === String(meeting.project));
        const byFilter = Boolean(await Meeting.exists({ _id: meeting._id, ...A.buildAiMeetingFilter(users[key], sc) }));
        expect({ key, meeting: meeting.topic, allowed: A.canAiViewMeeting(users[key], project, meeting) }).toEqual({ key, meeting: meeting.topic, allowed: byFilter });
      }
    }
    expect(A.canAiViewMeeting(users.member, P.private, M.privateMeeting)).toBe(true);
    expect(A.canAiViewMeeting(users.admin, P.orgVisible, M.orgMeeting)).toBe(true); // ordinary admin read of a non-private project's meeting
  });

  test('teams: the product\'s membership rule (admin / HR all; others lead or member), with PARITY; an unrelated manager sees nothing', async () => {
    const teams = await Team.find({}).lean();
    for (const key of ACTORS) {
      for (const t of teams) {
        const byFilter = Boolean(await Team.exists({ _id: t._id, ...A.buildAiTeamFilter(users[key]) }));
        expect({ key, team: t.name, allowed: A.canAiViewTeam(users[key], t) }).toEqual({ key, team: t.name, allowed: byFilter });
      }
    }
    expect(await Team.countDocuments(A.buildAiTeamFilter(users.manager))).toBe(1); // only the team they lead
    expect(await Team.countDocuments(A.buildAiTeamFilter(users.admin))).toBe(2);
    expect(await Team.countDocuments(A.buildAiTeamFilter(users.guest))).toBe(0);
  });

  test('people: only ACTIVE, non-blocked members of the SAME organization, for every role (stricter than the directory for admin/HR)', async () => {
    const seen = async (key) => (await User.find(A.buildAiPeopleFilter(users[key])).lean()).map((u) => u.firstName).sort();
    for (const key of ['admin', 'hr', 'manager', 'outsider']) {
      const list = await seen(key);
      expect(list).not.toContain(users.blocked.firstName);
      expect(list).not.toContain(users.inactive.firstName);
      expect(list).not.toContain(users.adminB.firstName);
      expect(list).toContain(users.member.firstName);
    }
    expect(await User.countDocuments(A.buildAiPeopleFilter(users.guest))).toBe(0);
    // the product directory DOES show inactive people to admin / HR: the AI rule is intentionally narrower
    expect(productPeople.canViewPerson(users.admin, users.inactive)).toBe(true);
    expect(A.canAiViewPerson(users.admin, users.inactive)).toBe(false);
    expect(A.canAiViewPerson(users.admin, users.adminB)).toBe(false);
    for (const key of ACTORS.filter((k) => !['blocked', 'inactive', 'guest'].includes(k))) {
      for (const person of await User.find({}).lean()) {
        const byFilter = Boolean(await User.exists({ _id: person._id, ...A.buildAiPeopleFilter(users[key]) }));
        expect(A.canAiViewPerson(users[key], person)).toBe(byFilter);
      }
    }
  });

  test('the product team rule used by AI is still the product\'s own (unchanged)', () => {
    expect(productTeam.canViewTeam(users.hr, team1)).toBe(true);
    expect(productTeam.canViewTeam(users.outsider, team1)).toBe(false);
  });
});

describe('scope resolution', () => {
  test('resolveAiScope returns the id sets the filters need, and classifies owner / member / manager from the data model', async () => {
    const sc = await scope.resolveAiScope(users.projectMgr);
    const ids = (list) => list.map(String).sort();
    expect(ids(sc.visibleProjectIds)).toEqual(ids([P.orgVisible._id, P.private._id]));
    expect(ids(sc.memberProjectIds)).toEqual(ids([P.orgVisible._id, P.private._id]));
    expect(ids(sc.managedProjectIds)).toEqual(ids([P.orgVisible._id, P.private._id]));
    const owner = await scope.resolveAiScope(users.owner);
    expect(ids(owner.managedProjectIds)).toEqual(ids([P.orgVisible._id, P.teamVisible._id, P.private._id])); // owner of all three live projects
    const admin = await scope.resolveAiScope(users.admin);
    expect(ids(admin.visibleProjectIds)).toEqual(ids([P.orgVisible._id, P.teamVisible._id]));
    expect(admin.memberProjectIds).toEqual([]);
    expect(admin.managedProjectIds).toEqual([]);
    expect(admin.truncated).toBe(false);
  });

  test('queries carry the caller\'s deadline (maxTimeMS) and do not throw with it set', async () => {
    await expect(scope.resolveAiScope(users.member, { maxTimeMs: 5000 })).resolves.toBeTruthy();
    await expect(scope.findAiTask(users.member, String(T.privAssignee._id), { maxTimeMs: 5000 })).resolves.toBeTruthy();
  });
});
