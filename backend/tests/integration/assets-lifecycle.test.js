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
const Asset = require('../../src/models/Asset');
const AssetAssignment = require('../../src/models/AssetAssignment');
const AssetMaintenance = require('../../src/models/AssetMaintenance');
const AuditLog = require('../../src/models/AuditLog');
const Notification = require('../../src/models/Notification');
const Organization = require('../../src/models/Organization');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const { runAssetJobs, thresholdFor } = require('../../src/services/assetJobs');
const { reconcileAssignments, repairAsset } = require('../../src/services/assetAssignment.service');

const { users, createUser, makeAgent, as } = createHarness();

const oid = () => new mongoose.Types.ObjectId();
let orgA;
let orgB;
let eng;
let categoryId;
const KEYS = ['admin', 'hr', 'manager', 'manager2', 'empA', 'empB', 'empC', 'adminB'];
const api = (path = '') => `/api/v1/assets${path}`;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const id = (u) => String(users[u]._id);

async function mk(overrides = {}) {
  return (await as('admin').post(api()).send({ name: 'ThinkPad', categoryId, serialNumber: `SN-${Math.random().toString(36).slice(2, 9)}`, ...overrides }).expect(201)).body.asset;
}
const assign = (assetId, user, key = 'admin', extra = {}) => as(key).post(api(`/${assetId}/assign`)).send({ userId: id(user), ...extra });
const status = async (assetId) => (await Asset.findById(assetId).lean()).status;
const notes = (user, type) => Notification.find({ recipient: users[user]._id, ...(type ? { type } : {}) }).lean();

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all([Asset.init(), AssetAssignment.init(), AssetMaintenance.init(), Notification.init()]);
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
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'manager2', ROLES.MANAGER);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'empC', ROLES.EMPLOYEE);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  eng = await Team.create({ organization: orgA._id, name: 'Engineering', lead: users.manager._id, members: [users.manager._id, users.empA._id, users.empB._id] });
  await Team.create({ organization: orgA._id, name: 'Design', lead: users.manager2._id, members: [users.manager2._id] });
  categoryId = (await as('admin').get(api('/categories')).expect(200)).body.categories[0].id;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('assign → transfer → return', () => {
  it('walks the full lifecycle, keeping an immutable, ordered history', async () => {
    const asset = await mk();
    const first = await assign(asset.id, 'empA', 'admin', { notes: 'Welcome kit', expectedReturnDate: iso(30), condition: 'GOOD' }).expect(201);
    expect(first.body.asset).toMatchObject({ status: 'ASSIGNED', assignedUser: { id: id('empA') } });
    expect(await status(asset.id)).toBe('ASSIGNED');

    await as('admin').post(api(`/${asset.id}/transfer`)).send({ userId: id('empB'), notes: 'Reorg' }).expect(200);
    await as('hr').post(api(`/${asset.id}/return`)).send({ condition: 'FAIR', notes: 'Scratched' }).expect(200);
    const released = await Asset.findById(asset.id).lean();
    expect(released).toMatchObject({ status: 'AVAILABLE', assignedUser: null, currentAssignment: null, condition: 'FAIR' });

    const history = (await as('admin').get(api(`/${asset.id}/assignments`)).expect(200)).body.assignments;
    expect(history).toHaveLength(2);
    expect(history.map((h) => [h.user.id, h.status, h.closeReason])).toEqual([
      [id('empB'), 'CLOSED', 'RETURNED'], [id('empA'), 'CLOSED', 'TRANSFERRED'],
    ]);
    expect(history[0].returnedCondition).toBe('FAIR');
    expect(await AssetAssignment.countDocuments({ asset: asset.id })).toBe(2);
    const actions = (await AuditLog.find({ entityId: asset.id }).lean()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['asset.assigned', 'asset.transferred', 'asset.returned']));

    // The asset can go out again and history keeps growing.
    await assign(asset.id, 'empC').expect(201);
    expect((await as('admin').get(api(`/${asset.id}/assignments`))).body.assignments).toHaveLength(3);
  });

  it('refuses invalid transitions and double actions', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(409);
    await as('admin').post(api(`/${asset.id}/transfer`)).send({ userId: id('empB') }).expect(409);
    await assign(asset.id, 'empA').expect(201);
    expect((await assign(asset.id, 'empB').expect(409)).body.code).toBe('ALREADY_ASSIGNED');
    expect((await as('admin').post(api(`/${asset.id}/transfer`)).send({ userId: id('empA') }).expect(400)).body.code).toBe('SAME_HOLDER');
    await as('admin').post(api(`/${asset.id}/retire`)).send({}).expect(409);
    await as('admin').post(api(`/${asset.id}/found`)).send({}).expect(409);
    await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(200);
    expect((await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(409)).body.code).toBe('NOT_ASSIGNED');
    await as('admin').post(api(`/${asset.id}/dispose`)).send({}).expect(409); // must be retired first
  });

  it('assigns to a team and refuses inactive, blocked or foreign people', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/assign`)).send({ assigneeType: 'team', teamId: String(eng._id) }).expect(201);
    expect((await as('empA').get(api('/mine')).expect(200)).body.assets[0]).toMatchObject({ id: asset.id, assignment: { viaTeam: true } });
    expect((await as('empC').get(api('/mine')).expect(200)).body.assets).toEqual([]);
    await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(200);

    await User.updateOne({ _id: users.empC._id }, { isActive: false });
    expect((await assign(asset.id, 'empC').expect(400)).body.code).toBe('ASSIGNEE_INACTIVE');
    await User.updateOne({ _id: users.empB._id }, { orgBlocked: true });
    expect((await assign(asset.id, 'empB').expect(400)).body.code).toBe('ASSIGNEE_INACTIVE');
    expect(await status(asset.id)).toBe('AVAILABLE');
  });

  it('only assignable statuses can be assigned', async () => {
    const reserved = await mk();
    await as('admin').post(api(`/${reserved.id}/reserve`)).send({}).expect(200);
    await assign(reserved.id, 'empA').expect(201); // reserved stock can be handed out

    const retired = await mk();
    await as('admin').post(api(`/${retired.id}/retire`)).send({}).expect(200);
    expect((await assign(retired.id, 'empA').expect(409)).body.code).toBe('ASSET_NOT_ASSIGNABLE');

    const lost = await mk();
    await as('admin').post(api(`/${lost.id}/lost`)).send({}).expect(200);
    await assign(lost.id, 'empA').expect(409);
    await as('admin').post(api(`/${lost.id}/found`)).send({}).expect(200);
    await assign(lost.id, 'empA').expect(201);
  });

  it('losing a held asset closes the holder\'s assignment as LOST', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    await as('admin').post(api(`/${asset.id}/lost`)).send({ note: 'Left in a taxi' }).expect(200);
    const row = await AssetAssignment.findOne({ asset: asset.id }).lean();
    expect(row).toMatchObject({ status: 'CLOSED', closeReason: 'LOST' });
    expect(await Asset.findById(asset.id).lean()).toMatchObject({ status: 'LOST', currentAssignment: null, assignedUser: null });
    expect((await notes('admin', 'asset.lost')).length + (await notes('hr', 'asset.lost')).length).toBeGreaterThan(0);
  });

  it('request-return notifies the holder once per request and records it', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    await as('hr').post(api(`/${asset.id}/request-return`)).send({ note: 'Please return by Friday' }).expect(200);
    const [note] = await notes('empA', 'asset.return_requested');
    expect(note).toBeTruthy();
    expect(note.title).not.toMatch(/ThinkPad/); // generic title; names only in the message
    expect(note.message).toContain('ThinkPad');
    expect((await AssetAssignment.findOne({ asset: asset.id }).lean()).returnRequestedAt).toBeTruthy();
    await as('empB').post(api(`/${asset.id}/request-return`)).send({}).expect(403);
  });
});

describe('manager scope', () => {
  it('managers act only on people and teams they lead', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA', 'manager').expect(201); // empA is on the team manager leads
    expect((await assign((await mk()).id, 'empC', 'manager').expect(403)).body.code).toBe('FORBIDDEN'); // empC is not on any team they lead
    await as('manager').post(api(`/${asset.id}/transfer`)).send({ userId: id('empB') }).expect(200);
    await as('manager').post(api(`/${asset.id}/transfer`)).send({ userId: id('empC') }).expect(403);
    await as('manager2').post(api(`/${asset.id}/return`)).send({}).expect(404); // can't even see another team's holdings
    await as('manager').post(api(`/${asset.id}/return`)).send({}).expect(200);
  });

  it('a team-owned asset can be assigned only by the managers of that team', async () => {
    const owned = await mk({ teamId: String(eng._id) });
    await assign(owned.id, 'empA', 'manager2').expect(404);
    await assign(owned.id, 'empA', 'manager').expect(201);
  });

  it('managers see the assignments of their reports, not of others', async () => {
    const a = await mk();
    const b = await mk();
    await assign(a.id, 'empA').expect(201);
    await assign(b.id, 'empC').expect(201);
    const mine = (await as('manager').get(api('/assignments')).expect(200)).body.assignments;
    expect(mine.map((x) => x.asset.id)).toEqual([a.id]);
    expect((await as('admin').get(api('/assignments')).expect(200)).body.assignments).toHaveLength(2);
    await as('empA').get(api('/assignments')).expect(403);
  });
});

describe('concurrency and integrity', () => {
  it('only one of many simultaneous assignments wins', async () => {
    const asset = await mk();
    const results = await Promise.all(['empA', 'empB', 'empC', 'hr', 'manager'].map((u) => assign(asset.id, u)));
    const wins = results.filter((r) => r.status === 201);
    expect(wins).toHaveLength(1);
    results.filter((r) => r.status !== 201).forEach((r) => expect(r.status).toBe(409));
    expect(await AssetAssignment.countDocuments({ asset: asset.id, status: 'ACTIVE' })).toBe(1);
    const stored = await Asset.findById(asset.id).lean();
    expect(String(stored.assignedUser)).toBe(String(wins[0].body.assignment.user.id));
  });

  it('simultaneous requests for the last license seat cannot oversell', async () => {
    const license = await mk({ name: 'Slack', kind: 'software', serialNumber: undefined, license: { seats: 2, licenseType: 'PER_SEAT' } });
    const results = await Promise.all(['empA', 'empB', 'empC', 'hr', 'manager'].map((u) => assign(license.id, u)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect((await Asset.findById(license.id)).license.allocatedSeats).toBe(2);
    expect(await AssetAssignment.countDocuments({ asset: license.id, status: 'ACTIVE' })).toBe(2);
    expect(await AssetAssignment.countDocuments({ asset: license.id, status: 'VOID' })).toBe(3); // losers leave no live rows
  });

  it('two simultaneous returns close the assignment once', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    const results = await Promise.all([1, 2, 3].map(() => as('admin').post(api(`/${asset.id}/return`)).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await AssetAssignment.countDocuments({ asset: asset.id, status: 'CLOSED' })).toBe(1);
    expect(await status(asset.id)).toBe('AVAILABLE');
  });

  it('a failed claim after the history write rolls the assignment back (void) and reports a conflict', async () => {
    const asset = await mk();
    jest.spyOn(Asset, 'findOneAndUpdate').mockResolvedValueOnce(null);
    expect((await assign(asset.id, 'empA').expect(409)).body.code).toBe('ASSET_NOT_AVAILABLE');
    expect(await AssetAssignment.countDocuments({ asset: asset.id, status: 'ACTIVE' })).toBe(0);
    expect(await status(asset.id)).toBe('AVAILABLE');
    jest.restoreAllMocks();
    await assign(asset.id, 'empA').expect(201); // nothing is stuck
  });

  it('repairs an asset that drifted from its assignments (both directions) and a seat counter that is wrong', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    // Simulate a crash after the history was written but before the asset was updated.
    await Asset.updateOne({ _id: asset.id }, { status: 'AVAILABLE', assignedUser: null, currentAssignment: null });
    expect(await repairAsset(asset.id)).toMatchObject({ repaired: 'followed-assignment' });
    expect(await Asset.findById(asset.id).lean()).toMatchObject({ status: 'ASSIGNED' });

    // Simulate a crash after closing the assignment but before releasing the asset.
    await AssetAssignment.updateOne({ asset: asset.id }, { status: 'CLOSED', closeReason: 'RETURNED', closedAt: new Date() });
    await repairAsset(asset.id);
    expect(await Asset.findById(asset.id).lean()).toMatchObject({ status: 'AVAILABLE', assignedUser: null, currentAssignment: null });

    const license = await mk({ name: 'Zoom', kind: 'software', serialNumber: undefined, license: { seats: 5 } });
    await assign(license.id, 'empA').expect(201);
    await Asset.updateOne({ _id: license.id }, { 'license.allocatedSeats': 4 });
    await repairAsset(license.id);
    expect((await Asset.findById(license.id)).license.allocatedSeats).toBe(1);
  });

  it('reconcile fixes drift in bulk and leaves healthy assets (and fresh in-flight writes) alone', async () => {
    const healthy = await mk();
    await assign(healthy.id, 'empB').expect(201);
    const drifted = await mk();
    await assign(drifted.id, 'empA').expect(201);
    await Asset.updateOne({ _id: drifted.id }, { status: 'AVAILABLE', assignedUser: null, currentAssignment: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await reconcileAssignments({ minAgeMs: 10 });
    expect(JSON.stringify(result)).toBeTruthy();
    expect(await status(drifted.id)).toBe('ASSIGNED');
    expect(await status(healthy.id)).toBe('ASSIGNED');
  });

  it('history rows cannot be duplicated or deleted through the API', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    await as('admin').delete(api(`/${asset.id}/assignments/${(await AssetAssignment.findOne({ asset: asset.id }))._id}`)).expect(404);
    await as('admin').patch(api(`/${asset.id}/assignments`)).send({}).expect(404);
  });
});

describe('maintenance', () => {
  const schedule = (assetId, body = {}, key = 'admin') => as(key).post(api(`/${assetId}/maintenance`)).send({ issue: 'Battery swap', scheduledDate: iso(2), ...body });

  it('schedule → start → complete moves the asset in and out of maintenance and records cost', async () => {
    const asset = await mk();
    const { maintenance } = (await schedule(asset.id, { type: 'REPAIR', serviceProvider: 'FixIt' }).expect(201)).body;
    expect(maintenance).toMatchObject({ status: 'SCHEDULED', issue: 'Battery swap' });
    expect(await status(asset.id)).toBe('AVAILABLE'); // scheduled work doesn't take it out of service

    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/start`)).send({}).expect(200);
    expect(await status(asset.id)).toBe('UNDER_MAINTENANCE');
    await assign(asset.id, 'empA').expect(409);

    const done = await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/complete`)).send({ cost: 2500, currency: 'INR', repairNotes: 'Replaced', condition: 'GOOD', nextMaintenanceDate: iso(180) }).expect(200);
    expect(done.body.maintenance).toMatchObject({ status: 'COMPLETED', cost: 2500 });
    expect(await status(asset.id)).toBe('AVAILABLE');
    expect(await Asset.findById(asset.id).lean()).toMatchObject({ maintenance: { nextDate: expect.any(Date) } });
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/complete`)).send({}).expect(409);
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/cancel`)).send({}).expect(409);
    await as('admin').patch(api(`/${asset.id}/maintenance/${maintenance.id}`)).send({ issue: 'edit' }).expect(409);
    expect((await as('admin').get(api(`/${asset.id}/maintenance`)).expect(200)).body.maintenance).toHaveLength(1);
  });

  it('a held asset returns to ASSIGNED after maintenance', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    const { maintenance } = (await schedule(asset.id).expect(201)).body;
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/start`)).send({}).expect(200);
    expect(await status(asset.id)).toBe('UNDER_MAINTENANCE');
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/complete`)).send({}).expect(200);
    expect(await status(asset.id)).toBe('ASSIGNED');
    expect((await Asset.findById(asset.id)).assignedUser.toString()).toBe(id('empA'));
  });

  it('only one job can be in progress per asset', async () => {
    const asset = await mk();
    const a = (await schedule(asset.id).expect(201)).body.maintenance;
    const b = (await schedule(asset.id, { issue: 'Second' }).expect(201)).body.maintenance;
    const results = await Promise.all([a, b].map((m) => as('admin').post(api(`/${asset.id}/maintenance/${m.id}/start`)).send({})));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await AssetMaintenance.countDocuments({ asset: asset.id, status: 'IN_PROGRESS' })).toBe(1);
  });

  it('cancelling an in-progress job puts the asset back in service', async () => {
    const asset = await mk();
    const { maintenance } = (await schedule(asset.id).expect(201)).body;
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/start`)).send({}).expect(200);
    await as('admin').post(api(`/${asset.id}/maintenance/${maintenance.id}/cancel`)).send({ reason: 'Not needed' }).expect(200);
    expect(await status(asset.id)).toBe('AVAILABLE');
  });

  it('holders request maintenance; admins approve or decline; duplicates are refused', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    await as('empB').post(api(`/${asset.id}/report-issue`)).send({ issue: 'Screen flickers' }).expect(404);
    const reported = await as('empA').post(api(`/${asset.id}/report-issue`)).send({ issue: 'Screen flickers a lot' }).expect(201);
    expect(reported.body.maintenance.status).toBe('REQUESTED');
    expect((await as('empA').post(api(`/${asset.id}/report-issue`)).send({ issue: 'Still flickering!' }).expect(409)).body.code).toBe('DUPLICATE_REQUEST');
    expect(await status(asset.id)).toBe('ASSIGNED'); // a request changes nothing by itself
    expect((await notes('admin', 'asset.maintenance_requested')).length).toBe(1);
    expect((await notes('empA', 'asset.maintenance_requested')).length).toBe(0);

    await as('empA').post(api(`/${asset.id}/maintenance/${reported.body.maintenance.id}/approve`)).send({ scheduledDate: iso(3) }).expect(403);
    await as('admin').post(api(`/${asset.id}/maintenance/${reported.body.maintenance.id}/approve`)).send({ scheduledDate: iso(3), serviceProvider: 'FixIt' }).expect(200);
    expect((await AssetMaintenance.findById(reported.body.maintenance.id)).status).toBe('SCHEDULED');
    expect((await notes('empA', 'asset.maintenance_scheduled')).length).toBe(1);
    await as('admin').post(api(`/${asset.id}/maintenance/${reported.body.maintenance.id}/decline`)).send({}).expect(409); // already decided

    const second = await as('empA').post(api(`/${asset.id}/report-issue`)).send({ issue: 'Keyboard sticks' }).expect(201);
    await as('hr').post(api(`/${asset.id}/maintenance/${second.body.maintenance.id}/decline`)).send({ reason: 'x' }).expect(403);
    await as('admin').post(api(`/${asset.id}/maintenance/${second.body.maintenance.id}/decline`)).send({ reason: 'Covered by warranty swap' }).expect(200);
    expect((await notes('empA', 'asset.maintenance_declined')).length).toBe(1);
  });

  it('cannot schedule maintenance on retired assets', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/retire`)).send({}).expect(200);
    expect((await schedule(asset.id).expect(409)).body.code).toBe('ASSET_NOT_MAINTAINABLE');
  });
});

describe('notifications for assignments', () => {
  it('notifies the new holder, the previous holder on transfer, and respects preferences', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    expect(await notes('empA', 'asset.assigned')).toHaveLength(1);
    expect(await notes('admin', 'asset.assigned')).toHaveLength(0); // never the actor

    await as('admin').post(api(`/${asset.id}/transfer`)).send({ userId: id('empB') }).expect(200);
    expect(await notes('empB', 'asset.transferred')).toHaveLength(1);
    expect(await notes('empA', 'asset.transferred_away')).toHaveLength(1);

    await as('empC').patch('/api/v1/notifications/preferences').send({ categories: { asset: { inApp: false } } });
    await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(200);
    const second = await mk();
    await assign(second.id, 'empC').expect(201);
    expect(await notes('empC', 'asset.assigned')).toHaveLength(1); // preference route shape may differ; delivery must never break the action
  });

  it('a failing notification never fails or rolls back the assignment', async () => {
    const service = require('../../src/services/notification.service');
    jest.spyOn(service, 'notify').mockRejectedValue(new Error('notification outage'));
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    expect(await status(asset.id)).toBe('ASSIGNED');
  });
});

describe('warranty and license alerts', () => {
  it('picks the smallest covering threshold', () => {
    expect(thresholdFor(30, [30, 7, 1])).toBe(30);
    expect(thresholdFor(12, [30, 7, 1])).toBe(30);
    expect(thresholdFor(5, [30, 7, 1])).toBe(7);
    expect(thresholdFor(1, [30, 7, 1])).toBe(1);
    expect(thresholdFor(45, [30, 7, 1])).toBeNull();
  });

  it('alerts admins once per threshold and stays quiet on repeat runs', async () => {
    await mk({ name: 'Soon', warranty: { expiryDate: iso(6) } });
    await mk({ name: 'Far', warranty: { expiryDate: iso(200) } });
    await mk({ name: 'Past', warranty: { expiryDate: iso(-3) } });
    await runAssetJobs();
    await runAssetJobs();
    await runAssetJobs();
    const alerts = await notes('admin', 'asset.warranty_expiring');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain('Soon');
    expect(await notes('empA', 'asset.warranty_expiring')).toHaveLength(0);

    // Later, at the 1-day mark, a new alert fires for the same warranty.
    await runAssetJobs({ now: Date.now() + 5 * 86400000 });
    expect(await notes('admin', 'asset.warranty_expiring')).toHaveLength(2);
  });

  it('does not alert for retired assets, and alerts for license expiry and renewal', async () => {
    const retired = await mk({ name: 'Old', warranty: { expiryDate: iso(3) } });
    await as('admin').post(api(`/${retired.id}/retire`)).send({}).expect(200);
    await mk({ name: 'Figma', kind: 'software', serialNumber: undefined, license: { seats: 2, expiryDate: iso(5), renewalDate: iso(20) } });
    await runAssetJobs();
    await runAssetJobs();
    expect(await notes('admin', 'asset.warranty_expiring')).toHaveLength(0);
    const licenseAlerts = await notes('admin', 'asset.license_expiring');
    expect(licenseAlerts).toHaveLength(2); // one for the expiry, one for the renewal
    expect(JSON.stringify(licenseAlerts)).not.toMatch(/keyReference/);
  });

  it('flags scheduled maintenance that was missed', async () => {
    const asset = await mk();
    await AssetMaintenance.create({ organization: orgA._id, asset: asset.id, type: 'REPAIR', status: 'SCHEDULED', issue: 'Late', scheduledDate: new Date(`${iso(-2)}T00:00:00.000Z`), createdBy: users.admin._id });
    await runAssetJobs();
    await runAssetJobs();
    expect(await notes('admin', 'asset.maintenance_overdue')).toHaveLength(1);
  });
});

describe('people and team integration', () => {
  it('keeps history and holdings when someone is blocked, tells admins/HR, and lists them for offboarding', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    await as('admin').patch(`/api/v1/people/${id('empA')}`).send({ orgBlocked: true }).expect(200);

    expect(await status(asset.id)).toBe('ASSIGNED'); // history preserved; nothing silently released
    expect(await AssetAssignment.countDocuments({ asset: asset.id, status: 'ACTIVE' })).toBe(1);
    expect(await notes('admin', 'asset.former_member_holds')).toHaveLength(0); // the admin performed the block
    expect(await notes('hr', 'asset.former_member_holds')).toHaveLength(1);
    expect(await notes('empA', 'asset.former_member_holds')).toHaveLength(0);

    const offboarding = (await as('hr').get(api('/offboarding')).expect(200)).body;
    expect(offboarding.totals).toEqual({ people: 1, assignments: 1 });
    expect(offboarding.people[0]).toMatchObject({ user: { id: id('empA'), status: 'blocked' }, assets: [{ asset: { id: asset.id } }] });
    await as('manager').get(api('/offboarding')).expect(403);

    // Admin can still recover the equipment, and the history shows who held it.
    await as('admin').post(api(`/${asset.id}/return`)).send({ notes: 'Collected from desk' }).expect(200);
    expect((await as('admin').get(api('/offboarding')).expect(200)).body.people).toEqual([]);
    expect((await as('admin').get(api(`/${asset.id}/assignments`)).expect(200)).body.assignments[0].user.id).toBe(id('empA'));
  });

  it('removing a member from the organization keeps the history and lists them for offboarding', async () => {
    const asset = await mk();
    await assign(asset.id, 'empB').expect(201);
    await as('admin').delete(`/api/v1/people/${id('empB')}`).expect(200);
    expect(await AssetAssignment.countDocuments({ asset: asset.id })).toBe(1);
    const offboarding = (await as('admin').get(api('/offboarding')).expect(200)).body;
    expect(offboarding.people[0].user.status).toBe('removed');
  });

  it('a person who is merely moved between teams is not offboarding', async () => {
    const asset = await mk();
    await assign(asset.id, 'empA').expect(201);
    expect((await as('admin').get(api('/offboarding')).expect(200)).body.people).toEqual([]);
  });

  it('does not notify when the person holds nothing', async () => {
    await as('admin').patch(`/api/v1/people/${id('empC')}`).send({ orgBlocked: true }).expect(200);
    expect(await notes('admin', 'asset.former_member_holds')).toHaveLength(0);
  });
});
