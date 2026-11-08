const request = require('supertest');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/utils/jwt');
const { ROLES } = require('../../src/constants/roles');
const User = require('../../src/models/User');

/**
 * Shared integration-test harness: builds the app, signs users in via bearer
 * tokens, and gives each user an agent that carries its own CSRF token.
 */
function createHarness() {
  const app = createApp();
  const agents = {};
  const users = {};

  async function createUser(org, key, role = ROLES.EMPLOYEE, overrides = {}) {
    users[key] = await User.create({
      organization: org._id,
      firstName: key.charAt(0).toUpperCase() + key.slice(1),
      lastName: 'Tester',
      email: `${key}@${org.slug}.test`,
      passwordHash: 'x',
      role,
      skills: [],
      isActive: true,
      emailVerified: true,
      hasCreatedOrganization: role === ROLES.ORG_ADMIN,
      ...overrides,
    });
    return users[key];
  }

  async function makeAgent(key) {
    const agent = request.agent(app);
    agent.set('Connection', 'close');
    const csrf = await agent.get('/api/v1/auth/csrf-token').expect(200);
    agent.csrfToken = csrf.body.csrfToken;
    agents[key] = agent;
    return agent;
  }

  const tokenFor = (key, options = {}) =>
    signAccessToken({ sub: users[key]._id.toString(), tv: users[key].tokenVersion, sid: 'test-session', ...options });

  // Always re-sign: a test may have changed the user since the last call.
  function as(key) {
    const agent = agents[key];
    agent.set('Authorization', `Bearer ${tokenFor(key)}`);
    return ['get', 'post', 'put', 'patch', 'delete'].reduce((acc, method) => {
      acc[method] = (path) => agent[method](path).set('x-csrf-token', agent.csrfToken);
      return acc;
    }, {});
  }

  return { app, agents, users, createUser, makeAgent, as, tokenFor };
}

module.exports = { createHarness };
