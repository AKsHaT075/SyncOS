jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendOtpEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendInvitationEmail: jest.fn().mockResolvedValue({ preview: true }),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { createApp } = require('../../src/app');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { signAccessToken } = require('../../src/utils/jwt');
const { ROLES } = require('../../src/constants/roles');
const User = require('../../src/models/User');
const Organization = require('../../src/models/Organization');
const Team = require('../../src/models/Team');

const app = createApp();

// TEMP flake instrumentation — captures any 4xx/5xx response body.
const Test = require('supertest/lib/test');
const flakyLog = [];
const originalEnd = Test.prototype.end;
Test.prototype.end = function wrappedEnd(fn) {
  return originalEnd.call(this, (err, res) => {
    if (res && res.status >= 400) {
      flakyLog.push(`${this.method} ${this.url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return fn ? fn(err, res) : undefined;
  });
};

let org;
let admin;
let hr;
let manager;
let employeeA;
let employeeB;
let guest;
let adminAgent;
let hrAgent;
let managerAgent;
let employeeAAgent;
let employeeBAgent;
let guestAgent;

async function createUser({ firstName, lastName, email, role }) {
  return User.create({
    organization: org._id,
    firstName,
    lastName,
    email,
    passwordHash: 'x',
    role,
    skills: [],
    isActive: true,
    emailVerified: true,
    hasCreatedOrganization: role === ROLES.ORG_ADMIN,
  });
}

async function createAgent() {
  const agent = request.agent(app);
  // Node's default http agent pools keep-alive sockets; across ~300 requests
  // per suite run the reused socket occasionally races with the server's
  // keepAliveTimeout and the next request arrives on a half-closed socket
  // ("Parse Error: Expected HTTP/..."). One connection per request makes the
  // suite deterministic.
  agent.set('Connection', 'close');
  const csrfRes = await agent.get('/api/v1/auth/csrf-token').expect(200);
  agent.csrfToken = csrfRes.body.csrfToken;
  return agent;
}

function signAgent(agent, user) {
  agent.set(
    'Authorization',
    `Bearer ${signAccessToken({ sub: user._id.toString(), tv: user.tokenVersion, sid: 'test-session' })}`,
  );
  return agent;
}

function mutate(agent) {
  return ['get', 'post', 'put', 'patch', 'delete'].reduce((acc, method) => {
    acc[method] = (path) => agent[method](path).set('x-csrf-token', agent.csrfToken);
    return acc;
  }, {});
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  [adminAgent, hrAgent, managerAgent, employeeAAgent, employeeBAgent, guestAgent] = await Promise.all([
    createAgent(),
    createAgent(),
    createAgent(),
    createAgent(),
    createAgent(),
    createAgent(),
  ]);
});

afterAll(async () => {
  if (flakyLog.length) {
    // eslint-disable-next-line no-console
    console.log('FLAKE RESPONSES:\n' + flakyLog.join('\n'));
  }
  await disconnectTestDb();
  await createRedisClient().quit();
});

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('teams & people — cross-module flows', () => {
  beforeEach(async () => {
    org = await Organization.create({
      name: 'Acme Inc',
      slug: `acme-${Date.now()}`,
      createdBy: new mongoose.Types.ObjectId(),
    });
    admin = await createUser({ firstName: 'Ada', lastName: 'Admin', email: 'admin@acme.test', role: ROLES.ORG_ADMIN });
    hr = await createUser({ firstName: 'Hrithik', lastName: 'Hr', email: 'hr@acme.test', role: ROLES.HR });
    manager = await createUser({ firstName: 'Mira', lastName: 'Manager', email: 'manager@acme.test', role: ROLES.MANAGER });
    employeeA = await createUser({ firstName: 'Eve', lastName: 'En', email: 'eve@acme.test', role: ROLES.EMPLOYEE });
    employeeB = await createUser({ firstName: 'Omar', lastName: 'On', email: 'omar@acme.test', role: ROLES.EMPLOYEE });
    guest = await createUser({ firstName: 'Gary', lastName: 'Guest', email: 'guest@acme.test', role: ROLES.GUEST });

    signAgent(adminAgent, admin);
    signAgent(hrAgent, hr);
    signAgent(managerAgent, manager);
    signAgent(employeeAAgent, employeeA);
    signAgent(employeeBAgent, employeeB);
    signAgent(guestAgent, guest);
  });

  describe('team creation & scoping', () => {
    it('lets an ORG_ADMIN create a team, see it in the list, and logs team.created', async () => {
      const res = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      expect(res.body.team.name).toBe('Engineering');
      expect(res.body.team.lead).toBeNull();
      expect(res.body.team.memberCount).toBe(0);
      expect(res.body.team.members).toEqual([]);
      expect(res.body.team.myStanding).toBeNull();

      const list = await adminAgent.get('/api/v1/teams').expect(200);
      expect(list.body.teams).toHaveLength(1);
      expect(list.body.teams[0].id).toBe(res.body.team.id);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(logs.body.logs.some((log) => log.action === 'team.created' && log.entityId === res.body.team.id)).toBe(true);
    });

    it('rejects duplicate team names case-insensitively', async () => {
      await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const dup = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'engineering' }).expect(409);
      expect(dup.body.code).toBe('TEAM_NAME_TAKEN');
    });

    it('rejects team creation by an employee', async () => {
      await mutate(employeeAAgent).post('/api/v1/teams').send({ name: 'Rogue Team' }).expect(403);
    });

    it('sets the lead at creation and keeps User.team consistent', async () => {
      const res = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);
      const teamId = res.body.team.id;

      expect(res.body.team.lead.id).toBe(manager._id.toString());
      expect(res.body.team.memberCount).toBe(1);

      const refreshed = await User.findById(manager._id);
      expect(refreshed.team.toString()).toBe(teamId);

      const myTeam = await managerAgent.get('/api/v1/teams/me').expect(200);
      expect(myTeam.body.team.id).toBe(teamId);
      expect(myTeam.body.team.myStanding).toBe('lead');
    });

    it('rejects assigning a non-manager as lead at creation', async () => {
      const res = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: employeeA._id.toString() })
        .expect(400);
      expect(res.body.code).toBe('INVALID_MANAGER_ROLE');
    });

    it('scopes an employee to teams they belong to only', async () => {
      const created = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);

      const list = await employeeBAgent.get('/api/v1/teams').expect(200);
      expect(list.body.teams).toHaveLength(0);

      const hidden = await employeeBAgent.get(`/api/v1/teams/${created.body.team.id}`).expect(403);
      expect(hidden.body.code).toBe('FORBIDDEN');

      await mutate(employeeBAgent)
        .post(`/api/v1/teams/${created.body.team.id}/members`)
        .send({ userId: employeeA._id.toString() })
        .expect(403);
    });

    it('lets admin update and delete a team, clearing member primary teams', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = created.body.team.id;

      await mutate(adminAgent)
        .post(`/api/v1/teams/${teamId}/members`)
        .send({ userId: employeeB._id.toString() })
        .expect(200);

      const updated = await mutate(adminAgent).patch(`/api/v1/teams/${teamId}`).send({ name: 'Core Engineering' }).expect(200);
      expect(updated.body.team.name).toBe('Core Engineering');

      await mutate(adminAgent).delete(`/api/v1/teams/${teamId}`).expect(200);

      await adminAgent.get(`/api/v1/teams/${teamId}`).expect(404);
      const refreshed = await User.findById(employeeB._id);
      expect(refreshed.team).toBeNull();
    });

    it('isolates teams between organizations', async () => {
      const otherOrg = await Organization.create({
        name: 'Rival Co',
        slug: `rival-${Date.now()}`,
        createdBy: new mongoose.Types.ObjectId(),
      });
      const rivalAdmin = await User.create({
        organization: otherOrg._id,
        firstName: 'Rex',
        lastName: 'Rival',
        email: 'rival@rival.test',
        passwordHash: 'x',
        role: ROLES.ORG_ADMIN,
        isActive: true,
        hasCreatedOrganization: true,
      });
      const rivalAgent = await createAgent();
      signAgent(rivalAgent, rivalAdmin);

      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);

      await rivalAgent.get(`/api/v1/teams/${created.body.team.id}`).expect(404);
      const rivalList = await rivalAgent.get('/api/v1/teams').expect(200);
      expect(rivalList.body.teams).toHaveLength(0);
    });
  });

  describe('team membership consistency', () => {
    it('adds a member and keeps the roster and primary team in sync', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = created.body.team.id;

      const res = await mutate(adminAgent)
        .post(`/api/v1/teams/${teamId}/members`)
        .send({ userId: employeeA._id.toString() })
        .expect(200);
      expect(res.body.team.memberCount).toBe(1);
      expect(res.body.team.members[0].id).toBe(employeeA._id.toString());

      const myTeam = await employeeAAgent.get('/api/v1/teams/me').expect(200);
      expect(myTeam.body.team.id).toBe(teamId);
      expect(myTeam.body.team.myStanding).toBe('member');

      const dbTeam = await Team.findById(teamId);
      expect(dbTeam.members.map((m) => m.toString())).toContain(employeeA._id.toString());
    });


    it('rejects duplicate membership', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = created.body.team.id;

      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeA._id.toString() }).expect(200);
      const dup = await mutate(adminAgent)
        .post(`/api/v1/teams/${teamId}/members`)
        .send({ userId: employeeA._id.toString() })
        .expect(409);
      expect(dup.body.code).toBe('ALREADY_MEMBER');
    });

    it('moves a member out of their previous team when added elsewhere', async () => {
      const t1 = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const t2 = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Design' }).expect(201);
      const t1Id = t1.body.team.id;
      const t2Id = t2.body.team.id;

      await mutate(adminAgent).post(`/api/v1/teams/${t1Id}/members`).send({ userId: employeeA._id.toString() }).expect(200);
      await mutate(adminAgent).post(`/api/v1/teams/${t2Id}/members`).send({ userId: employeeA._id.toString() }).expect(200);

      const t1Res = await adminAgent.get(`/api/v1/teams/${t1Id}`).expect(200);
      expect(t1Res.body.team.memberCount).toBe(0);

      const myTeam = await employeeAAgent.get('/api/v1/teams/me').expect(200);
      expect(myTeam.body.team.id).toBe(t2Id);
    });

    it('rejects moving a user who manages another team', async () => {
      await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);
      const t2 = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Design' }).expect(201);

      const res = await mutate(adminAgent)
        .post(`/api/v1/teams/${t2.body.team.id}/members`)
        .send({ userId: manager._id.toString() })
        .expect(409);
      expect(res.body.code).toBe('LEAD_OF_OTHER_TEAM');
    });

    it('removes a member and clears their primary team if it was this team', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = created.body.team.id;

      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeB._id.toString() }).expect(200);
      const removed = await mutate(adminAgent).delete(`/api/v1/teams/${teamId}/members/${employeeB._id.toString()}`).expect(200);
      expect(removed.body.team.memberCount).toBe(0);

      const refreshed = await User.findById(employeeB._id);
      expect(refreshed.team).toBeNull();
    });

    it('blocks removing the team manager before reassignment', async () => {
      const created = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);

      const res = await mutate(adminAgent)
        .delete(`/api/v1/teams/${created.body.team.id}/members/${manager._id.toString()}`)
        .expect(409);
      expect(res.body.code).toBe('LEAD_REASSIGN_REQUIRED');
    });

    it('lists member candidates excluding current members and leads of other teams', async () => {
      const managerB = await createUser({ firstName: 'Milo', lastName: 'Manager', email: 'milo@acme.test', role: ROLES.MANAGER });
      const t1 = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: managerB._id.toString() })
        .expect(201);
      const t2 = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Design' }).expect(201);

      await mutate(adminAgent).post(`/api/v1/teams/${t2.body.team.id}/members`).send({ userId: employeeB._id.toString() }).expect(200);

      const candidates = await adminAgent.get(`/api/v1/teams/${t2.body.team.id}/member-candidates`).expect(200);
      const ids = candidates.body.candidates.map((c) => c.id);
      expect(ids).not.toContain(managerB._id.toString());
      expect(ids).not.toContain(employeeB._id.toString());
      expect(ids).toContain(manager._id.toString());
      expect(t1.body.team.id).toBeTruthy();
    });
  });


  describe('manager assignment', () => {
    it('assigns a manager and reflects the standing for everyone', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = created.body.team.id;

      const res = await mutate(adminAgent).put(`/api/v1/teams/${teamId}/manager`).send({ userId: manager._id.toString() }).expect(200);
      expect(res.body.team.lead.id).toBe(manager._id.toString());
      expect(res.body.team.memberCount).toBe(1);

      const myTeam = await managerAgent.get('/api/v1/teams/me').expect(200);
      expect(myTeam.body.team.id).toBe(teamId);
      expect(myTeam.body.team.myStanding).toBe('lead');
    });

    it('rejects assigning a manager who manages another team', async () => {
      await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);
      const t2 = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Design' }).expect(201);

      const res = await mutate(adminAgent)
        .put(`/api/v1/teams/${t2.body.team.id}/manager`)
        .send({ userId: manager._id.toString() })
        .expect(409);
      expect(res.body.code).toBe('LEAD_OF_OTHER_TEAM');
    });

    it('rejects assigning the current manager', async () => {
      const created = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: manager._id.toString() })
        .expect(201);

      const res = await mutate(adminAgent)
        .put(`/api/v1/teams/${created.body.team.id}/manager`)
        .send({ userId: manager._id.toString() })
        .expect(409);
      expect(res.body.code).toBe('ALREADY_MANAGER');
    });

    it('rejects assigning a non-manager as team manager', async () => {
      const created = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);

      const res = await mutate(adminAgent)
        .put(`/api/v1/teams/${created.body.team.id}/manager`)
        .send({ userId: employeeA._id.toString() })
        .expect(400);
      expect(res.body.code).toBe('INVALID_MANAGER_ROLE');
    });
  });


  describe('people directory', () => {
    it('lists the full directory for an org-admin with email and skills', async () => {
      const res = await adminAgent.get('/api/v1/people').expect(200);
      expect(res.body.people).toHaveLength(6);
      expect(res.body.pagination.total).toBe(6);
      expect(res.body.people[0].email).toBeTruthy();
      expect(res.body.people[0].skills).toBeDefined();
    });

    it('filters the directory by role, team and search', async () => {
      const byRole = await adminAgent.get(`/api/v1/people?role=${ROLES.MANAGER}`).expect(200);
      expect(byRole.body.people).toHaveLength(1);
      expect(byRole.body.people[0].id).toBe(manager._id.toString());

      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = team.body.team.id;
      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeA._id.toString() }).expect(200);

      const byTeam = await adminAgent.get(`/api/v1/people?team=${teamId}`).expect(200);
      expect(byTeam.body.people.map((p) => p.id)).toEqual([employeeA._id.toString()]);

      const bySearch = await adminAgent.get('/api/v1/people?search=omar').expect(200);
      expect(bySearch.body.people.map((p) => p.id)).toEqual([employeeB._id.toString()]);
    });

    it('sorts the directory by role hierarchy, not alphabetically', async () => {
      const res = await adminAgent.get('/api/v1/people?sortBy=role&sortOrder=asc').expect(200);
      expect(res.body.people.map((p) => p.id)).toEqual([
        admin._id.toString(),
        manager._id.toString(),
        hr._id.toString(),
        employeeA._id.toString(),
        employeeB._id.toString(),
        guest._id.toString(),
      ]);

      const desc = await adminAgent.get('/api/v1/people?sortBy=role&sortOrder=desc').expect(200);
      expect(desc.body.people.map((p) => p.id)).toEqual([
        guest._id.toString(),
        employeeA._id.toString(),
        employeeB._id.toString(),
        hr._id.toString(),
        manager._id.toString(),
        admin._id.toString(),
      ]);
    });

    it('lets a manager view the full active directory (product decision)', async () => {
      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering', lead: manager._id.toString() }).expect(201);
      const teamId = team.body.team.id;
      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeA._id.toString() }).expect(200);
      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeB._id.toString() }).expect(200);

      const res = await managerAgent.get('/api/v1/people').expect(200);
      const ids = res.body.people.map((p) => p.id);
      expect(ids).toHaveLength(6);
      expect(ids).toContain(manager._id.toString());
      expect(ids).toContain(employeeA._id.toString());
      expect(ids).toContain(employeeB._id.toString());
      expect(ids).toContain(admin._id.toString());
      expect(ids).toContain(hr._id.toString());
      expect(ids).toContain(guest._id.toString());
    });

    it('excludes inactive users from a manager directory', async () => {
      // isActive can no longer be toggled through the API (deactivating a
      // user is an account-wide effect and no single org should be able to
      // do that to someone who may belong to other orgs — see orgBlocked
      // for the org-scoped equivalent). This exercises the directory
      // filter's handling of isActive directly against the DB.
      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering', lead: manager._id.toString() }).expect(201);
      const teamId = team.body.team.id;
      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeA._id.toString() }).expect(200);

      await User.findByIdAndUpdate(employeeA._id, { isActive: false });

      const res = await managerAgent.get('/api/v1/people').expect(200);
      expect(res.body.people.map((p) => p.id)).not.toContain(employeeA._id.toString());

      const adminView = await adminAgent.get(`/api/v1/people/${employeeA._id.toString()}`).expect(200);
      expect(adminView.body.person.isActive).toBe(false);
    });

    it('serves a guest only minimal fields without email', async () => {
      const res = await guestAgent.get('/api/v1/people').expect(200);
      expect(res.body.people).toHaveLength(6);
      const first = res.body.people[0];
      expect(first.id).toBeTruthy();
      expect(first.firstName).toBeTruthy();
      expect(first.email).toBeUndefined();
      expect(first.skills).toBeUndefined();
    });

    it('blocks an employee from managing another user', async () => {
      await mutate(employeeAAgent).patch(`/api/v1/people/${employeeB._id.toString()}`).send({ skills: ['hacking'] }).expect(403);
    });
  });


  describe('person profile updates', () => {
    it('updates skills and logs person.updated', async () => {
      const res = await mutate(adminAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ skills: ['node', 'react'] })
        .expect(200);
      expect(res.body.person.skills).toEqual(['node', 'react']);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some(
          (log) =>
            log.action === 'person.updated' &&
            log.entityId === employeeA._id.toString() &&
            log.metadata.fields.includes('skills'),
        ),
      ).toBe(true);
    });

    it('moves a person to a team through the team service and logs the change', async () => {
      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = team.body.team.id;

      const res = await mutate(adminAgent).patch(`/api/v1/people/${employeeA._id.toString()}`).send({ teamId }).expect(200);
      expect(res.body.person.team.id).toBe(teamId);

      const dbTeam = await Team.findById(teamId);
      expect(dbTeam.members.map((m) => m.toString())).toContain(employeeA._id.toString());

      const myTeam = await employeeAAgent.get('/api/v1/teams/me').expect(200);
      expect(myTeam.body.team.id).toBe(teamId);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(logs.body.logs.some((log) => log.action === 'person.team_changed' && log.entityId === employeeA._id.toString())).toBe(true);
    });

    it('removes a person from all teams with teamId null', async () => {
      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = team.body.team.id;
      await mutate(adminAgent).patch(`/api/v1/people/${employeeA._id.toString()}`).send({ teamId }).expect(200);

      const res = await mutate(adminAgent).patch(`/api/v1/people/${employeeA._id.toString()}`).send({ teamId: null }).expect(200);
      expect(res.body.person.team).toBeNull();

      const dbTeam = await Team.findById(teamId);
      expect(dbTeam.members).toHaveLength(0);
    });

    it('an inactive user\'s token stops working (isActive is no longer settable via the people API — deactivation is not an org-scoped action)', async () => {
      await User.findByIdAndUpdate(employeeB._id, { isActive: false });

      await employeeBAgent.get('/api/v1/teams/me').expect(401);
      const me = await adminAgent.get(`/api/v1/people/${employeeB._id.toString()}`).expect(200);
      expect(me.body.person.isActive).toBe(false);
    });
  });

  describe('role changes', () => {
    it('lets an org-admin change an employee role and logs rbac.role_changed', async () => {
      const res = await mutate(adminAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ role: ROLES.MANAGER })
        .expect(200);
      expect(res.body.person.role).toBe(ROLES.MANAGER);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some(
          (log) =>
            log.action === 'rbac.role_changed' &&
            log.entityId === employeeA._id.toString() &&
            log.metadata.from === ROLES.EMPLOYEE &&
            log.metadata.to === ROLES.MANAGER,
        ),
      ).toBe(true);
    });

    it('blocks HR from changing roles even though HR can manage employees', async () => {
      const res = await mutate(hrAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ role: ROLES.MANAGER })
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('blocks changing your own role', async () => {
      const res = await mutate(adminAgent)
        .patch(`/api/v1/people/${admin._id.toString()}`)
        .send({ role: ROLES.ADMIN })
        .expect(400);
      expect(res.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
    });

    it('rejects assigning org-admin or super-admin through the people directory', async () => {
      await mutate(adminAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ role: ROLES.ORG_ADMIN })
        .expect(400);
      await mutate(adminAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ role: ROLES.SUPER_ADMIN })
        .expect(400);
    });
  });

  describe('org-level blocking', () => {
    it('lets an org-admin block a user: they stay authenticated but every org-scoped route rejects them', async () => {
      await mutate(adminAgent)
        .patch(`/api/v1/people/${employeeA._id.toString()}`)
        .send({ orgBlocked: true })
        .expect(200);

      const me = await employeeAAgent.get('/api/v1/auth/me').expect(200);
      expect(me.body.user.orgBlocked).toBe(true);

      const blocked = await employeeAAgent.get('/api/v1/people').expect(403);
      expect(blocked.body.code).toBe('ORG_BLOCKED');

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some((log) => log.action === 'person.blocked' && log.entityId === employeeA._id.toString()),
      ).toBe(true);
    });

    it('restores access on unblock', async () => {
      await mutate(adminAgent).patch(`/api/v1/people/${employeeA._id.toString()}`).send({ orgBlocked: true }).expect(200);
      await mutate(adminAgent).patch(`/api/v1/people/${employeeA._id.toString()}`).send({ orgBlocked: false }).expect(200);

      await employeeAAgent.get('/api/v1/people').expect(200);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some((log) => log.action === 'person.unblocked' && log.entityId === employeeA._id.toString()),
      ).toBe(true);
    });

    it('blocks blocking your own account', async () => {
      const res = await mutate(adminAgent)
        .patch(`/api/v1/people/${admin._id.toString()}`)
        .send({ orgBlocked: true })
        .expect(400);
      expect(res.body.code).toBe('CANNOT_BLOCK_SELF');
    });
  });

  describe('remove from organization', () => {
    it('lets an org-admin remove a user: org/team detached and their token stops working', async () => {
      const team = await mutate(adminAgent).post('/api/v1/teams').send({ name: 'Engineering' }).expect(201);
      const teamId = team.body.team.id;
      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeA._id.toString() }).expect(200);

      await mutate(adminAgent).delete(`/api/v1/people/${employeeA._id.toString()}`).expect(200);

      const refreshed = await User.findById(employeeA._id);
      expect(refreshed.organization).toBeNull();
      expect(refreshed.team).toBeNull();

      const dbTeam = await Team.findById(teamId);
      expect(dbTeam.members.map((m) => m.toString())).not.toContain(employeeA._id.toString());

      await employeeAAgent.get('/api/v1/teams/me').expect(401);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some((log) => log.action === 'person.removed_from_org' && log.entityId === employeeA._id.toString()),
      ).toBe(true);
    });

    it('blocks HR from removing users from the organization', async () => {
      const res = await mutate(hrAgent).delete(`/api/v1/people/${employeeA._id.toString()}`).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('blocks removing your own account', async () => {
      const res = await mutate(adminAgent).delete(`/api/v1/people/${admin._id.toString()}`).expect(400);
      expect(res.body.code).toBe('CANNOT_REMOVE_SELF');
    });
  });

  describe('force password reset', () => {
    it('revokes sessions, sends a reset email, and logs person.sessions_revoked', async () => {
      const { sendPasswordResetEmail } = require('../../src/services/email.service');

      await mutate(adminAgent).post(`/api/v1/people/${employeeA._id.toString()}/force-password-reset`).expect(200);

      expect(sendPasswordResetEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: employeeA.email }),
      );

      await employeeAAgent.get('/api/v1/teams/me').expect(401);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      expect(
        logs.body.logs.some(
          (log) => log.action === 'person.sessions_revoked' && log.entityId === employeeA._id.toString(),
        ),
      ).toBe(true);
    });

    it('lets HR force-reset a manageable employee, but not a manager', async () => {
      await mutate(hrAgent).post(`/api/v1/people/${employeeA._id.toString()}/force-password-reset`).expect(200);
      await mutate(hrAgent).post(`/api/v1/people/${manager._id.toString()}/force-password-reset`).expect(403);
    });

    it('blocks resetting your own password through this action', async () => {
      const res = await mutate(adminAgent).post(`/api/v1/people/${admin._id.toString()}/force-password-reset`).expect(400);
      expect(res.body.code).toBe('CANNOT_RESET_OWN_PASSWORD');
    });
  });

  describe('audit logging', () => {
    it('records team lifecycle and membership events', async () => {
      const managerB = await createUser({ firstName: 'Milo', lastName: 'Manager', email: 'milo@acme.test', role: ROLES.MANAGER });
      const created = await mutate(adminAgent)
        .post('/api/v1/teams')
        .send({ name: 'Engineering', lead: managerB._id.toString() })
        .expect(201);
      const teamId = created.body.team.id;

      await mutate(adminAgent).post(`/api/v1/teams/${teamId}/members`).send({ userId: employeeB._id.toString() }).expect(200);
      await mutate(adminAgent).put(`/api/v1/teams/${teamId}/manager`).send({ userId: manager._id.toString() }).expect(200);

      const logs = await adminAgent.get('/api/v1/audit-logs').expect(200);
      const actions = logs.body.logs.map((log) => log.action);
      expect(actions).toContain('team.created');
      expect(actions).toContain('team.member_added');
      expect(actions).toContain('team.manager_changed');
      expect(logs.body.logs.some((log) => log.action === 'team.manager_changed' && log.metadata.from === managerB._id.toString() && log.metadata.to === manager._id.toString())).toBe(true);
    });
  });
});

