const mongoose = require('mongoose');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const checkOwnership = require('../../src/middlewares/checkOwnership');
const { ROLES } = require('../../src/constants/roles');

const fixtureSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, required: true },
});
const Fixture = mongoose.models.OwnershipFixture || mongoose.model('OwnershipFixture', fixtureSchema);

function mockRes() {
  return {};
}

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, mockRes(), (err) => resolve(err));
  });
}

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('checkOwnership middleware', () => {
  it('returns 404 for a resource that exists but belongs to a different organization', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const resource = await Fixture.create({ organization: orgB, owner });

    const req = {
      params: { id: resource._id.toString() },
      user: { _id: owner, organization: orgA },
    };

    const err = await runMiddleware(checkOwnership(Fixture, { ownerField: 'owner', resourceName: 'Fixture' }), req);

    expect(err).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('returns 403 when the resource is in-org but not owned and the role is not bypassed', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const someoneElse = new mongoose.Types.ObjectId();
    const resource = await Fixture.create({ organization: orgA, owner });

    const req = {
      params: { id: resource._id.toString() },
      user: { _id: someoneElse, organization: orgA, role: ROLES.EMPLOYEE },
    };

    const err = await runMiddleware(checkOwnership(Fixture, { ownerField: 'owner', bypassRoles: [ROLES.ORG_ADMIN] }), req);

    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('allows the owner through and attaches req.resource', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const resource = await Fixture.create({ organization: orgA, owner });

    const req = {
      params: { id: resource._id.toString() },
      user: { _id: owner, organization: orgA, role: ROLES.EMPLOYEE },
    };

    const err = await runMiddleware(checkOwnership(Fixture, { ownerField: 'owner' }), req);

    expect(err).toBeUndefined();
    expect(req.resource._id.toString()).toBe(resource._id.toString());
  });

  it('allows a bypass role through even without ownership', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    const admin = new mongoose.Types.ObjectId();
    const resource = await Fixture.create({ organization: orgA, owner });

    const req = {
      params: { id: resource._id.toString() },
      user: { _id: admin, organization: orgA, role: ROLES.ORG_ADMIN },
    };

    const err = await runMiddleware(checkOwnership(Fixture, { ownerField: 'owner', bypassRoles: [ROLES.ORG_ADMIN] }), req);

    expect(err).toBeUndefined();
  });
});
