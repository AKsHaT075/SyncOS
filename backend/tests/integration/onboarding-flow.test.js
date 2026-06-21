jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendOtpEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendInvitationEmail: jest.fn().mockResolvedValue({ preview: true }),
}));

const request = require('supertest');
const { createApp } = require('../../src/app');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const emailService = require('../../src/services/email.service');

const app = createApp();

function lastOtpFor(email) {
  const call = emailService.sendOtpEmail.mock.calls.find((args) => args[0].to === email);
  return call[0].otp;
}

function lastInviteTokenFor(email) {
  const call = emailService.sendInvitationEmail.mock.calls.find((args) => args[0].to === email);
  const url = new URL(call[0].inviteUrl);
  return url.searchParams.get('token');
}

async function registerVerifyLogin(agent, { firstName, lastName, email, password }) {
  await agent.post('/api/v1/auth/register').send({ firstName, lastName, email, password }).expect(201);
  const otp = lastOtpFor(email);
  await agent.post('/api/v1/auth/verify-email').send({ email, otp }).expect(200);
  await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
}

async function getCsrfToken(agent) {
  const res = await agent.get('/api/v1/auth/csrf-token').expect(200);
  return res.body.csrfToken;
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
});

afterAll(async () => {
  await disconnectTestDb();
  await createRedisClient().quit();
});

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('onboarding -> invite -> accept flow', () => {
  it('lets a new user create an organization and become ORG_ADMIN', async () => {
    const agent = request.agent(app);
    const email = 'founder@acme.test';
    await registerVerifyLogin(agent, { firstName: 'Ada', lastName: 'Admin', email, password: 'Password123' });

    const csrfToken = await getCsrfToken(agent);
    const res = await agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme Inc' })
      .expect(201);

    expect(res.body.organization.name).toBe('Acme Inc');

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.role).toBe('org-admin');
    expect(me.body.user.hasCreatedOrganization).toBe(true);
  });

  it('blocks creating a second organization for the same user', async () => {
    const agent = request.agent(app);
    const email = 'founder2@acme.test';
    await registerVerifyLogin(agent, { firstName: 'Ada', lastName: 'Admin', email, password: 'Password123' });

    const csrfToken = await getCsrfToken(agent);
    await agent.post('/api/v1/organizations').set('x-csrf-token', csrfToken).send({ name: 'Acme Inc' }).expect(201);

    const csrfToken2 = await getCsrfToken(agent);
    const res = await agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', csrfToken2)
      .send({ name: 'Second Co' })
      .expect(409);

    expect(res.body.code).toBe('ORGANIZATION_ALREADY_CREATED');
  });

  it('invites a user, who joins the inviter org with the assigned role on accept', async () => {
    const adminAgent = request.agent(app);
    const adminEmail = 'admin@acme.test';
    await registerVerifyLogin(adminAgent, { firstName: 'Ada', lastName: 'Admin', email: adminEmail, password: 'Password123' });
    const orgCsrf = await getCsrfToken(adminAgent);
    await adminAgent.post('/api/v1/organizations').set('x-csrf-token', orgCsrf).send({ name: 'Acme Inc' }).expect(201);

    const inviteCsrf = await getCsrfToken(adminAgent);
    const inviteeEmail = 'employee@acme.test';
    await adminAgent
      .post('/api/v1/invitations')
      .set('x-csrf-token', inviteCsrf)
      .send({ email: inviteeEmail, role: 'employee' })
      .expect(201);

    const token = lastInviteTokenFor(inviteeEmail);
    const acceptRes = await request(app)
      .post('/api/v1/invitations/accept')
      .send({ token, firstName: 'Eve', lastName: 'Employee', password: 'Password123' })
      .expect(201);

    expect(acceptRes.body.user.role).toBe('employee');
    expect(acceptRes.body.user.organization).toBeTruthy();

    const listRes = await adminAgent.get('/api/v1/invitations').set('x-csrf-token', inviteCsrf).expect(200);
    expect(listRes.body.invitations[0].status).toBe('accepted');
  });

  it('never lets one organization see another organization invitations or audit logs', async () => {
    const adminA = request.agent(app);
    await registerVerifyLogin(adminA, { firstName: 'Org', lastName: 'A', email: 'a-admin@acme.test', password: 'Password123' });
    const csrfA1 = await getCsrfToken(adminA);
    await adminA.post('/api/v1/organizations').set('x-csrf-token', csrfA1).send({ name: 'Org A' }).expect(201);
    const csrfA2 = await getCsrfToken(adminA);
    await adminA
      .post('/api/v1/invitations')
      .set('x-csrf-token', csrfA2)
      .send({ email: 'invitee-a@acme.test', role: 'employee' })
      .expect(201);

    const adminB = request.agent(app);
    await registerVerifyLogin(adminB, { firstName: 'Org', lastName: 'B', email: 'b-admin@acme.test', password: 'Password123' });
    const csrfB1 = await getCsrfToken(adminB);
    await adminB.post('/api/v1/organizations').set('x-csrf-token', csrfB1).send({ name: 'Org B' }).expect(201);

    const invitesForB = await adminB.get('/api/v1/invitations').expect(200);
    expect(invitesForB.body.invitations).toHaveLength(0);

    const auditLogsForB = await adminB.get('/api/v1/audit-logs').expect(200);
    const orgAActionLeak = auditLogsForB.body.logs.find((log) => log.metadata?.email === 'invitee-a@acme.test');
    expect(orgAActionLeak).toBeUndefined();
  });
});
