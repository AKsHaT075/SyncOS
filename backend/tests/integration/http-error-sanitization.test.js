jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/** Step 9E: no HTTP error response ever carries a stack trace, path or internal text; the diagnostics go to the server log. */
const request = require('supertest');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiSettings = require('../../src/services/ai/aiSettings.service');
const AppError = require('../../src/utils/app-error');
const { errorHandler } = require('../../src/middlewares/error.middleware');

const { createUser, makeAgent, as, app } = createHarness();
const redis = () => createRedisClient();
const LEAKY = /stack|node_modules|\/Users\/|\.js:\d+|at .*\(|mongodb:\/\/|SECRET-INTERNAL/i;
let org;

beforeAll(async () => { await connectTestDb(); await connectRedis(); });
afterAll(async () => { await hub.shutdown(); await disconnectTestDb(); await redis().quit(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Organization, User].map((m) => m.deleteMany({})));
  org = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: new (require('mongoose').Types.ObjectId)() });
  await createUser(org, 'emp', ROLES.EMPLOYEE);
  await makeAgent('emp');
});

test('an unexpected failure returns the fixed 500 shape: no stack, no internal text; the stack goes to the SERVER log', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(aiSettings, 'getStatus').mockRejectedValue(new Error('SECRET-INTERNAL mongodb://user:pw@10.0.0.5/db exploded'));
  const res = await as('emp').get('/api/v1/ai/status');
  expect(res.status).toBe(500);
  expect(Object.keys(res.body).sort()).toEqual(['code', 'details', 'message', 'success']);
  expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' });
  expect(JSON.stringify(res.body)).not.toMatch(LEAKY);
  const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  expect(logged).toContain('GET /api/v1/ai/status -> 500'); // diagnostics are available server-side
  expect(logged).toContain('SECRET-INTERNAL'); // ...including the original error, in the protected log only
});

test('operational errors (4xx) keep their friendly message and code, with no stack', async () => {
  const notFound = await request(app).get('/api/v1/this-route-does-not-exist');
  expect(notFound.status).toBe(404);
  expect(notFound.body).toMatchObject({ code: 'ROUTE_NOT_FOUND', success: false });
  expect(JSON.stringify(notFound.body)).not.toMatch(/stack|node_modules|\/Users\//i);
  const validation = await as('emp').post('/api/v1/ai/conversations').send({ unexpected: true });
  expect(validation.status).toBe(400);
  expect(Object.keys(validation.body).sort()).toEqual(['code', 'details', 'message', 'success']);
});

test('the query string never reaches the log (it can hold tokens)', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(aiSettings, 'getStatus').mockRejectedValue(new Error('boom'));
  await as('emp').get('/api/v1/ai/status?token=SECRET-QUERY-TOKEN');
  expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toContain('SECRET-QUERY-TOKEN');
});

test('the handler itself (unit): a thrown AppError and a raw Error both leave without a stack', () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const send = (err) => {
    const out = {};
    errorHandler(err, { method: 'GET', path: '/x' }, { headersSent: false, status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } }, () => {});
    return out;
  };
  const a = send(new AppError('Nope', 403, 'FORBIDDEN'));
  expect(a).toEqual({ status: 403, body: { code: 'FORBIDDEN', details: null, message: 'Nope', success: false } });
  const b = send(Object.assign(new Error('internal path /srv/app/x.js:1'), { statusCode: 502, code: 'AI_X' }));
  expect(JSON.stringify(b.body)).not.toMatch(/stack/i);
  expect(b.status).toBe(502);
  expect(log).toHaveBeenCalledTimes(1); // 5xx only
});
