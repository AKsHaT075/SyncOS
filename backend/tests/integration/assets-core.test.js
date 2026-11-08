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
const AssetCategory = require('../../src/models/AssetCategory');
const AuditLog = require('../../src/models/AuditLog');
const Document = require('../../src/models/Document');
const Notification = require('../../src/models/Notification');
const Organization = require('../../src/models/Organization');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');

const { users, createUser, makeAgent, as } = createHarness();

const oid = () => new mongoose.Types.ObjectId();
let orgA;
let orgB;
let eng;
let categoryId;

const KEYS = ['admin', 'hr', 'manager', 'manager2', 'empA', 'empB', 'empC', 'guest', 'adminB', 'empOtherOrg'];
const api = (path = '') => `/api/v1/assets${path}`;

async function mk(key = 'admin', overrides = {}) {
  const res = await as(key).post(api()).send({ name: 'ThinkPad X1', categoryId, serialNumber: `SN-${Math.random().toString(36).slice(2, 9)}`, ...overrides }).expect(201);
  return res.body.asset;
}
const mkLicense = (overrides = {}) =>
  mk('admin', { name: 'Figma', kind: 'software', serialNumber: undefined, license: { seats: 3, licenseType: 'PER_SEAT', keyReference: '1Password: IT/Figma', expiryDate: '2027-01-31' }, ...overrides });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all([Asset.init(), AssetAssignment.init(), Notification.init()]);
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
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empOtherOrg', ROLES.EMPLOYEE);
  eng = await Team.create({ organization: orgA._id, name: 'Engineering', lead: users.manager._id, members: [users.manager._id, users.empA._id, users.empB._id] });
  await Team.create({ organization: orgA._id, name: 'Design', lead: users.manager2._id, members: [users.manager2._id] });
  categoryId = (await as('admin').get(api('/categories')).expect(200)).body.categories[0].id;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('permissions', () => {
  it('guests have no asset access at all', async () => {
    for (const call of [
      () => as('guest').get(api()), () => as('guest').get(api('/mine')), () => as('guest').get(api('/summary')),
      () => as('guest').post(api()).send({ name: 'x', categoryId }), () => as('guest').get(api('/categories')),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call();
      expect(res.status).toBe(403);
    }
  });

  it('employees only reach "mine" and assets they hold', async () => {
    const asset = await mk();
    await as('empA').get(api()).expect(403);
    await as('empA').post(api()).send({ name: 'x', categoryId }).expect(403);
    await as('empA').get(api('/summary')).expect(403);
    await as('empA').get(api(`/${asset.id}`)).expect(404); // not theirs: invisible, not forbidden
    expect((await as('empA').get(api('/mine')).expect(200)).body.assets).toEqual([]);

    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);
    expect((await as('empA').get(api('/mine')).expect(200)).body.assets).toHaveLength(1);
    await as('empA').get(api(`/${asset.id}`)).expect(200);
    await as('empA').patch(api(`/${asset.id}`)).send({ name: 'Mine now' }).expect(403);
    await as('empA').delete(api(`/${asset.id}`)).expect(403);
    await as('empA').post(api(`/${asset.id}/return`)).send({}).expect(403);
    await as('empA').post(api(`/${asset.id}/transfer`)).send({ userId: users.empB._id.toString() }).expect(403);
    await as('empB').get(api(`/${asset.id}`)).expect(404);
  });

  it('HR can see, assign, transfer, return and export — but not create, edit or delete inventory', async () => {
    const asset = await mk();
    await as('hr').get(api(`/${asset.id}`)).expect(200);
    await as('hr').post(api(`/${asset.id}/assign`)).send({ userId: users.empC._id.toString() }).expect(201);
    await as('hr').post(api(`/${asset.id}/transfer`)).send({ userId: users.empB._id.toString() }).expect(200);
    await as('hr').post(api(`/${asset.id}/return`)).send({}).expect(200);
    await as('hr').get(api('/export')).expect(200);
    await as('hr').post(api()).send({ name: 'x', categoryId }).expect(403);
    await as('hr').patch(api(`/${asset.id}`)).send({ name: 'x' }).expect(403);
    await as('hr').delete(api(`/${asset.id}`)).expect(403);
    await as('hr').post(api('/categories')).send({ name: 'Drones' }).expect(403);
    await as('hr').post(api(`/${asset.id}/maintenance`)).send({ issue: 'x', scheduledDate: '2027-01-01' }).expect(403);
  });

  it('managers cannot manage inventory or see reports', async () => {
    const asset = await mk();
    await as('manager').post(api()).send({ name: 'x', categoryId }).expect(403);
    await as('manager').patch(api(`/${asset.id}`)).send({ name: 'x' }).expect(403);
    await as('manager').get(api('/export')).expect(403);
    await as('manager').post(api('/vendors')).send({ name: 'Dell' }).expect(403);
  });
});

describe('creating and reading assets', () => {
  it('creates an asset with generated per-organization IDs and sensible defaults', async () => {
    const first = await mk('admin', { name: 'MacBook Pro', brand: 'Apple', model: 'M3', purchase: { date: '2026-01-15', cost: 189900 } });
    const second = await mk();
    expect(first).toMatchObject({
      assetId: 'AST-000001', name: 'MacBook Pro', kind: 'hardware', status: 'AVAILABLE', condition: 'GOOD', brand: 'Apple',
      purchase: { date: '2026-01-15', cost: 189900, currency: 'INR' }, assignedUser: null, archived: false,
    });
    expect(second.assetId).toBe('AST-000002');
    expect(await Asset.countDocuments({ organization: orgA._id })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'asset.created', entityId: first.id })).toBe(1);

    // Another organization numbers its own assets independently.
    const other = (await as('adminB').post(api()).send({ name: 'Dell', categoryId: (await as('adminB').get(api('/categories'))).body.categories[0].id }).expect(201)).body.asset;
    expect(other.assetId).toBe('AST-000001');
  });

  it('keeps asset tags and serial numbers unique within an organization only', async () => {
    await mk('admin', { assetTag: 'LAP-001', serialNumber: 'SER-1' });
    expect((await as('admin').post(api()).send({ name: 'x', categoryId, assetTag: 'LAP-001' }).expect(409)).body.code).toBe('DUPLICATE_ASSET');
    expect((await as('admin').post(api()).send({ name: 'x', categoryId, serialNumber: 'SER-1' }).expect(409)).body.details.field).toBe('serialNumber');
    // Two assets may both have NO tag / serial.
    await mk('admin', { serialNumber: undefined });
    await mk('admin', { serialNumber: undefined });
    // The same tag in a different organization is fine.
    const otherCategory = (await as('adminB').get(api('/categories'))).body.categories[0].id;
    await as('adminB').post(api()).send({ name: 'x', categoryId: otherCategory, assetTag: 'LAP-001', serialNumber: 'SER-1' }).expect(201);
  });

  it('validates input', async () => {
    const bad = (body, code) => as('admin').post(api()).send({ name: 'x', categoryId, ...body }).expect(400).then((res) => code && expect(res.body.code).toBe(code));
    await bad({ name: '' });
    await bad({ categoryId: 'nope' });
    await bad({ kind: 'furniture' });
    await bad({ kind: 'software' }); // needs license details
    await bad({ license: { seats: 5 } }); // hardware has no license
    await bad({ kind: 'software', license: { seats: 0 } });
    await bad({ kind: 'software', license: { seats: 5, expiryDate: '2025-01-01', startDate: '2026-01-01' } });
    await bad({ purchase: { cost: -5 } });
    await bad({ purchase: { currency: 'XYZ' } });
    await bad({ warranty: { startDate: '2026-05-01', expiryDate: '2026-01-01' } });
    await bad({ purchase: { date: '2026-02-30' } });
    await bad({ condition: 'SHINY' });
    await bad({ organization: String(orgB._id) }); // unknown fields rejected
    await bad({ status: 'RETIRED' }); // status can't be set directly
    await bad({ assignedUser: String(users.empA._id) });
    expect(await Asset.countDocuments()).toBe(0);
  });

  it('rejects categories, vendors and teams from another organization', async () => {
    const otherCat = (await as('adminB').get(api('/categories'))).body.categories[0].id;
    const otherVendor = (await as('adminB').post(api('/vendors')).send({ name: 'Foreign Co' }).expect(201)).body.vendor.id;
    const otherTeam = await Team.create({ organization: orgB._id, name: 'Foreign', members: [] });
    await as('admin').post(api()).send({ name: 'x', categoryId: otherCat }).expect(404);
    await as('admin').post(api()).send({ name: 'x', categoryId, purchase: { vendorId: otherVendor } }).expect(404);
    await as('admin').post(api()).send({ name: 'x', categoryId, teamId: String(otherTeam._id) }).expect(404);
    expect(await Asset.countDocuments()).toBe(0);
  });

  it('stores date-only values without timezone drift', async () => {
    const asset = await mk('admin', { warranty: { startDate: '2026-03-01', expiryDate: '2027-02-28' }, purchase: { date: '2026-03-01' } });
    const stored = await Asset.findById(asset.id).lean();
    expect(stored.warranty.expiryDate.toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(asset.warranty).toEqual({ startDate: '2026-03-01', expiryDate: '2027-02-28' });
  });
});

describe('updating, archiving and restoring', () => {
  it('updates fields, keeps kind fixed, and refuses duplicate identifiers', async () => {
    const a = await mk('admin', { serialNumber: 'SER-A' });
    const b = await mk('admin', { serialNumber: 'SER-B' });
    const res = await as('admin').patch(api(`/${a.id}`)).send({ name: 'Renamed', location: 'HQ - Floor 2', condition: 'FAIR', warranty: { expiryDate: '2028-01-01' }, notes: 'Dented lid' }).expect(200);
    expect(res.body.asset).toMatchObject({ name: 'Renamed', location: 'HQ - Floor 2', condition: 'FAIR', notes: 'Dented lid', warranty: { expiryDate: '2028-01-01' } });
    await as('admin').patch(api(`/${a.id}`)).send({ serialNumber: 'SER-B' }).expect(409);
    await as('admin').patch(api(`/${a.id}`)).send({ kind: 'software' }).expect(400);
    await as('admin').patch(api(`/${a.id}`)).send({ status: 'DISPOSED' }).expect(400);
    await as('admin').patch(api(`/${a.id}`)).send({}).expect(400);
    await as('admin').patch(api(`/${a.id}`)).send({ warranty: { startDate: '2029-01-01' } }).expect(400); // would end before it starts
    expect(await AuditLog.countDocuments({ action: 'asset.updated', entityId: a.id })).toBe(1);
    void b;
  });

  it('archives (never hard-deletes) and restores; held assets cannot be archived', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);
    expect((await as('admin').delete(api(`/${asset.id}`)).expect(409)).body.code).toBe('ASSET_IN_USE');
    await as('admin').post(api(`/${asset.id}/return`)).send({}).expect(200);

    await as('admin').delete(api(`/${asset.id}`)).expect(200);
    expect((await as('admin').get(api()).expect(200)).body.assets).toHaveLength(0);
    expect((await as('admin').get(api('?includeArchived=true')).expect(200)).body.assets.map((x) => x.id)).toEqual([asset.id]);
    expect(await Asset.countDocuments({ _id: asset.id })).toBe(1);
    expect(await AssetAssignment.countDocuments({ asset: asset.id })).toBe(1); // history survives archiving
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(404); // archived assets are gone from workflows

    await as('admin').post(api(`/${asset.id}/restore`)).expect(200);
    expect((await as('admin').get(api()).expect(200)).body.assets).toHaveLength(1);
  });

  it('a disposed asset is read-only', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/retire`)).send({}).expect(200);
    await as('admin').post(api(`/${asset.id}/dispose`)).send({}).expect(200);
    expect((await as('admin').patch(api(`/${asset.id}`)).send({ name: 'x' }).expect(409)).body.code).toBe('ASSET_DISPOSED');
  });
});

describe('search, filters, sorting and pagination (server-side)', () => {
  beforeEach(async () => {
    const laptops = categoryId;
    const monitors = (await as('admin').get(api('/categories'))).body.categories.find((c) => c.name === 'Monitors & Displays').id;
    await mk('admin', { name: 'Alpha Laptop', serialNumber: 'AAA111', location: 'HQ', categoryId: laptops, teamId: String(eng._id), warranty: { expiryDate: '2020-01-01' }, purchase: { date: '2025-01-10', cost: 50000 } });
    await mk('admin', { name: 'Bravo Monitor', serialNumber: 'BBB222', location: 'Remote', categoryId: monitors, warranty: { expiryDate: '2099-01-01' }, purchase: { date: '2026-03-10', cost: 9000 } });
    await mk('admin', { name: 'Charlie Laptop', serialNumber: 'CCC333', location: 'HQ', categoryId: laptops, purchase: { date: '2026-06-01', cost: 70000 } });
  });

  const names = async (query, key = 'admin') => (await as(key).get(api(`?${new URLSearchParams(query)}&sortBy=name&sortOrder=asc`)).expect(200)).body.assets.map((a) => a.name);

  it('searches by name, asset id, tag and serial number (case-insensitive, regex-safe)', async () => {
    expect(await names({ search: 'laptop' })).toEqual(['Alpha Laptop', 'Charlie Laptop']);
    expect(await names({ search: 'bbb222' })).toEqual(['Bravo Monitor']);
    expect(await names({ search: 'AST-000003' })).toEqual(['Charlie Laptop']);
    expect(await names({ search: '.*' })).toEqual([]);
  });

  it('filters by category, status, team, location, warranty and purchase date', async () => {
    expect(await names({ location: 'hq' })).toEqual(['Alpha Laptop', 'Charlie Laptop']);
    expect(await names({ teamId: String(eng._id) })).toEqual(['Alpha Laptop']);
    expect(await names({ warranty: 'expired' })).toEqual(['Alpha Laptop']);
    expect(await names({ warranty: 'active' })).toEqual(['Bravo Monitor']);
    expect(await names({ warranty: 'none' })).toEqual(['Charlie Laptop']);
    expect(await names({ status: 'AVAILABLE,RETIRED' })).toHaveLength(3);
    expect(await names({ status: 'ASSIGNED' })).toEqual([]);
    expect(await names({ purchasedFrom: '2026-01-01', purchasedTo: '2026-04-01' })).toEqual(['Bravo Monitor']);
    expect(await names({ holder: 'unassigned' })).toHaveLength(3);
  });

  it('sorts and paginates on the server', async () => {
    const page = await as('admin').get(api('?sortBy=name&sortOrder=desc&limit=2&page=2')).expect(200);
    expect(page.body.assets.map((a) => a.name)).toEqual(['Alpha Laptop']);
    expect(page.body.pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
    const byCost = await as('admin').get(api('?sortBy=cost&sortOrder=desc')).expect(200);
    expect(byCost.body.assets.map((a) => a.name)).toEqual(['Charlie Laptop', 'Alpha Laptop', 'Bravo Monitor']);
    await as('admin').get(api('?limit=500')).expect(400);
    await as('admin').get(api('?sortBy=password')).expect(400);
    await as('admin').get(api('?organization=x')).expect(400);
  });

  it('lists distinct locations for the filter dropdown', async () => {
    expect((await as('admin').get(api('/options')).expect(200)).body.locations).toEqual(['HQ', 'Remote']);
  });
});

describe('categories', () => {
  it('seeds the default categories once per organization', async () => {
    const { categories } = (await as('admin').get(api('/categories')).expect(200)).body;
    expect(categories.map((c) => c.name)).toEqual([
      'Computers & Laptops', 'Furniture', 'Mobile Devices', 'Monitors & Displays', 'Networking Equipment', 'Office Equipment', 'Other', 'Printers & Scanners', 'Software & Licenses',
    ]);
    expect(await AssetCategory.countDocuments({ organization: orgA._id })).toBe(9);
    await as('admin').get(api('/categories')).expect(200);
    expect(await AssetCategory.countDocuments({ organization: orgA._id })).toBe(9);
  });

  it('creates, renames, and rejects duplicates case-insensitively', async () => {
    const created = (await as('admin').post(api('/categories')).send({ name: 'Audio Gear' }).expect(201)).body.category;
    expect((await as('admin').post(api('/categories')).send({ name: 'audio gear' }).expect(409)).body.code).toBe('DUPLICATE_CATEGORY');
    const renamed = await as('admin').patch(api(`/categories/${created.id}`)).send({ name: 'Audio & Video' }).expect(200);
    expect(renamed.body.category.name).toBe('Audio & Video');
    await as('admin').patch(api(`/categories/${created.id}`)).send({ name: 'Furniture' }).expect(409);
  });

  it('will not archive a category that still has assets unless they are moved somewhere safe', async () => {
    await mk();
    const [{ id: inUse }] = (await as('admin').get(api('/categories')).expect(200)).body.categories.filter((c) => c.assetCount > 0);
    const target = (await as('admin').post(api('/categories')).send({ name: 'Target' }).expect(201)).body.category.id;

    const refused = await as('admin').post(api(`/categories/${inUse}/archive`)).send({}).expect(409);
    expect(refused.body.code).toBe('CATEGORY_IN_USE');
    await as('admin').post(api(`/categories/${inUse}/archive`)).send({ moveTo: inUse }).expect(400); // not to itself
    expect((await as('admin').post(api(`/categories/${inUse}/archive`)).send({ moveTo: target }).expect(200)).body.moved).toBe(1);

    expect(await Asset.countDocuments({ category: target })).toBe(1); // never orphaned
    const active = (await as('admin').get(api('/categories')).expect(200)).body.categories;
    expect(active.some((c) => c.id === inUse)).toBe(false);
    await as('admin').post(api()).send({ name: 'x', categoryId: inUse }).expect(404); // archived: not available for new assets
    await as('admin').post(api(`/categories/${inUse}/archive`)).send({}).expect(200); // idempotent
  });

  it('keeps categories organization-scoped', async () => {
    const mine = (await as('admin').post(api('/categories')).send({ name: 'Mine Only' }).expect(201)).body.category;
    await as('adminB').patch(api(`/categories/${mine.id}`)).send({ name: 'Hijack' }).expect(404);
    await as('adminB').post(api(`/categories/${mine.id}/archive`)).send({}).expect(404);
    expect((await as('adminB').get(api('/categories')).expect(200)).body.categories.some((c) => c.name === 'Mine Only')).toBe(false);
  });
});

describe('vendors', () => {
  it('manages a lightweight directory and links vendors to assets', async () => {
    const vendor = (await as('hr').post(api('/vendors')).send({ name: 'Dell India', contactPerson: 'Asha', email: 'Sales@Dell.example', phone: '+91 80 0000', website: 'https://dell.example' }).expect(201)).body.vendor;
    expect(vendor).toMatchObject({ name: 'Dell India', email: 'sales@dell.example', assetCount: 0 });
    await as('admin').post(api('/vendors')).send({ name: 'dell india' }).expect(409);
    await as('admin').post(api('/vendors')).send({ name: 'x', email: 'not-an-email' }).expect(400);
    await as('admin').post(api('/vendors')).send({ name: 'x', website: 'javascript:alert(1)' }).expect(400);

    const asset = await mk('admin', { purchase: { vendorId: vendor.id, cost: 1000 } });
    expect(asset.purchase.vendor).toEqual({ id: vendor.id, name: 'Dell India' });
    expect((await as('admin').get(api('/vendors')).expect(200)).body.vendors[0].assetCount).toBe(1);

    await as('admin').patch(api(`/vendors/${vendor.id}`)).send({ phone: '123' }).expect(200);
    await as('admin').delete(api(`/vendors/${vendor.id}`)).expect(200);
    expect((await as('admin').get(api('/vendors')).expect(200)).body.vendors).toHaveLength(0);
    await as('admin').post(api()).send({ name: 'x', categoryId, purchase: { vendorId: vendor.id } }).expect(404); // archived vendors can't be chosen
    expect((await as('admin').get(api(`/${asset.id}`)).expect(200)).body.asset.purchase.vendor.name).toBe('Dell India'); // history keeps the link
  });

  it('keeps vendors organization-scoped', async () => {
    const vendor = (await as('admin').post(api('/vendors')).send({ name: 'Local Co' }).expect(201)).body.vendor;
    await as('adminB').patch(api(`/vendors/${vendor.id}`)).send({ name: 'Hijack' }).expect(404);
    await as('adminB').delete(api(`/vendors/${vendor.id}`)).expect(404);
    expect((await as('adminB').get(api('/vendors')).expect(200)).body.vendors).toEqual([]);
  });
});

describe('software licenses and seats', () => {
  it('creates a license asset; only license managers see the key reference, and it never appears in logs or exports', async () => {
    const license = await mkLicense();
    expect(license).toMatchObject({ kind: 'software', license: { seats: 3, allocatedSeats: 0, availableSeats: 3, expiryDate: '2027-01-31', hasKeyReference: true, keyReference: '1Password: IT/Figma' } });

    const asHr = (await as('hr').get(api(`/${license.id}`)).expect(200)).body.asset;
    expect(asHr.license.hasKeyReference).toBe(true);
    expect(asHr.license).not.toHaveProperty('keyReference');

    await as('admin').patch(api(`/${license.id}`)).send({ license: { keyReference: 'Vault/other-item', seats: 5 } }).expect(200);
    const logs = JSON.stringify(await AuditLog.find({ entityId: license.id }).lean());
    expect(logs).not.toMatch(/1Password|Vault\/other-item/);
    const activity = JSON.stringify((await as('admin').get(api(`/${license.id}/activity`)).expect(200)).body);
    expect(activity).not.toMatch(/1Password|Vault/);
    const csv = (await as('admin').get(api('/export')).expect(200)).text;
    expect(csv).not.toMatch(/1Password|Vault/);
    expect(csv).toContain('Figma');
  });

  it('allocates one seat per person, atomically, and frees it on return', async () => {
    const license = await mkLicense();
    const give = (user) => as('admin').post(api(`/${license.id}/assign`)).send({ userId: users[user]._id.toString() });

    await give('empA').expect(201);
    expect((await give('empA').expect(409)).body.code).toBe('ALREADY_ASSIGNED'); // one seat per person
    await give('empB').expect(201);
    await give('empC').expect(201);
    expect((await give('hr').expect(409)).body.code).toBe('NO_SEATS_AVAILABLE');
    expect((await Asset.findById(license.id)).license.allocatedSeats).toBe(3);

    await as('admin').post(api(`/${license.id}/return`)).send({ userId: users.empB._id.toString() }).expect(200);
    expect((await Asset.findById(license.id)).license.allocatedSeats).toBe(2);
    await give('hr').expect(201);
    await as('admin').post(api(`/${license.id}/return`)).send({ userId: users.empB._id.toString() }).expect(409); // already returned
    expect(await AssetAssignment.countDocuments({ asset: license.id, status: 'ACTIVE' })).toBe(3);
    expect((await as('empA').get(api('/mine')).expect(200)).body.assets[0].name).toBe('Figma');
  });

  it('refuses seats on expired licenses, team seats, and shrinking below what is in use', async () => {
    const expired = await mkLicense({ name: 'Old', license: { seats: 2, expiryDate: '2020-01-01' } });
    expect((await as('admin').post(api(`/${expired.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(409)).body.code).toBe('LICENSE_EXPIRED');

    const license = await mkLicense();
    await as('admin').post(api(`/${license.id}/assign`)).send({ assigneeType: 'team', teamId: String(eng._id) }).expect(400);
    await as('admin').post(api(`/${license.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);
    await as('admin').post(api(`/${license.id}/assign`)).send({ userId: users.empB._id.toString() }).expect(201);
    expect((await as('admin').patch(api(`/${license.id}`)).send({ license: { seats: 1 } }).expect(409)).body.code).toBe('SEATS_IN_USE');
    await as('admin').patch(api(`/${license.id}`)).send({ license: { seats: 2 } }).expect(200);
    expect((await as('admin').post(api(`/${license.id}/retire`)).send({}).expect(409)).body.code).toBe('ASSET_IN_USE'); // seats still in use
    await as('hr').patch(api(`/${license.id}`)).send({ license: { seats: 9 } }).expect(403);
  });

  it('hardware cannot have a license and licenses cannot be lost or maintained', async () => {
    const hardware = await mk();
    await as('admin').patch(api(`/${hardware.id}`)).send({ license: { seats: 2 } }).expect(400);
    const license = await mkLicense();
    await as('admin').post(api(`/${license.id}/lost`)).send({}).expect(400);
    await as('admin').post(api(`/${license.id}/maintenance`)).send({ issue: 'x', scheduledDate: '2027-01-01' }).expect(400);
  });
});

describe('linked documents (no duplicate storage)', () => {
  const mkDoc = (overrides = {}) =>
    Document.create({
      organization: orgA._id, name: 'Invoice.pdf', owner: users.admin._id, visibility: 'organization', extension: 'pdf', category: 'pdf',
      mimeType: 'application/pdf', size: 100, checksum: 'x', storageKey: `${orgA._id}/${Math.random().toString(36).slice(2)}`, ...overrides,
    });

  it('links existing documents; the file is stored once and the link grants nothing by itself', async () => {
    const asset = await mk();
    const shared = await mkDoc();
    const secret = await mkDoc({ name: 'Board-only.pdf', visibility: 'private', owner: users.empB._id });
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);

    await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(shared._id), kind: 'invoice' }).expect(201);
    await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(secret._id), kind: 'warranty' }).expect(404); // the actor can't see it either
    expect((await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(shared._id) }).expect(409)).body.code).toBe('ALREADY_LINKED');
    expect(await Document.countDocuments()).toBe(2); // nothing was copied

    // A private document owned by the admin is linked by the admin…
    const ownerPrivate = await mkDoc({ name: 'Warranty.pdf', visibility: 'private' });
    await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(ownerPrivate._id), kind: 'warranty' }).expect(201);

    // …the holder sees the shared one, but only a placeholder for the private one.
    const seen = (await as('empA').get(api(`/${asset.id}/documents`)).expect(200)).body.documents;
    expect(seen).toHaveLength(2);
    expect(seen.find((d) => d.kind === 'invoice')).toMatchObject({ status: 'ok', document: { name: 'Invoice.pdf' } });
    expect(seen.find((d) => d.kind === 'warranty')).toMatchObject({ status: 'restricted', document: null });
    expect(JSON.stringify(seen)).not.toContain('Warranty.pdf');
  });

  it('handles deleted documents gracefully and unlinking never deletes the file', async () => {
    const asset = await mk();
    const doc = await mkDoc();
    const { linkId } = (await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(doc._id), kind: 'manual' }).expect(201)).body;
    await Document.updateOne({ _id: doc._id }, { deletedAt: new Date() });
    expect((await as('admin').get(api(`/${asset.id}/documents`)).expect(200)).body.documents[0]).toMatchObject({ status: 'unavailable', document: null });
    await as('admin').delete(api(`/${asset.id}/documents/${linkId}`)).expect(200);
    expect((await as('admin').get(api(`/${asset.id}/documents`)).expect(200)).body.documents).toEqual([]);
    expect(await Document.countDocuments({ _id: doc._id })).toBe(1);
  });

  it('sets the asset image from a linked image document only', async () => {
    const asset = await mk();
    const pdf = await mkDoc();
    const photo = await mkDoc({ name: 'photo.png', extension: 'png', category: 'image', mimeType: 'image/png' });
    expect((await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(pdf._id), kind: 'image' }).expect(400)).body.code).toBe('NOT_AN_IMAGE');
    const { linkId } = (await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(photo._id), kind: 'image' }).expect(201)).body;
    expect((await as('admin').get(api(`/${asset.id}`)).expect(200)).body.asset.imageDocument).toBe(String(photo._id));
    await as('admin').delete(api(`/${asset.id}/documents/${linkId}`)).expect(200);
    expect((await as('admin').get(api(`/${asset.id}`)).expect(200)).body.asset.imageDocument).toBeNull();
  });

  it('refuses other organizations\' documents and users who cannot manage the asset', async () => {
    const asset = await mk();
    const foreign = await Document.create({
      organization: orgB._id, name: 'Foreign.pdf', owner: users.adminB._id, visibility: 'organization', extension: 'pdf', category: 'pdf',
      mimeType: 'application/pdf', size: 1, checksum: 'x', storageKey: `${orgB._id}/f1`,
    });
    await as('admin').post(api(`/${asset.id}/documents`)).send({ documentId: String(foreign._id), kind: 'other' }).expect(404);
    await as('hr').post(api(`/${asset.id}/documents`)).send({ documentId: String((await mkDoc())._id), kind: 'other' }).expect(403); // HR can't edit inventory
    await as('adminB').get(api(`/${asset.id}/documents`)).expect(404);
  });
});

describe('dashboard and reports use real data', () => {
  it('aggregates live counts, groups, expiries and per-currency purchase value', async () => {
    const laptops = categoryId;
    const monitors = (await as('admin').get(api('/categories'))).body.categories.find((c) => c.name === 'Monitors & Displays').id;
    const a = await mk('admin', { name: 'A', categoryId: laptops, teamId: String(eng._id), purchase: { cost: 1000, currency: 'INR' }, warranty: { expiryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) } });
    await mk('admin', { name: 'B', categoryId: laptops, purchase: { cost: 500, currency: 'INR' } });
    await mk('admin', { name: 'C', categoryId: monitors, purchase: { cost: 40, currency: 'USD' } });
    const retired = await mk('admin', { name: 'D', categoryId: monitors, purchase: { cost: 60, currency: 'USD' } });
    await as('admin').post(api(`/${a.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);
    await as('admin').post(api(`/${retired.id}/retire`)).send({}).expect(200);

    const s = (await as('admin').get(api('/summary')).expect(200)).body;
    expect(s.totals).toMatchObject({ total: 4, available: 2, assigned: 1, retired: 1, underMaintenance: 0, lost: 0 });
    expect(s.byStatus.find((x) => x.status === 'ASSIGNED').count).toBe(1);
    expect(s.byCategory.map((c) => [c.name, c.count]).sort()).toEqual([['Computers & Laptops', 2], ['Monitors & Displays', 2]]);
    expect(s.byTeam.find((t) => t.name === 'Engineering').count).toBe(1);
    expect(s.assignmentDistribution).toEqual([{ id: String(users.empA._id), name: 'EmpA Tester', count: 1 }]);
    // Different currencies are reported separately — never added together.
    expect(s.purchaseValue.byCurrency).toEqual([{ currency: 'INR', total: 1500, assets: 2 }, { currency: 'USD', total: 100, assets: 2 }]);
    expect(s.valueByCategory).toEqual(expect.arrayContaining([
      { category: 'Computers & Laptops', currency: 'INR', total: 1500, assets: 2 },
      { category: 'Monitors & Displays', currency: 'USD', total: 100, assets: 2 },
    ]));
    expect(s.expiringWarranties).toHaveLength(1);
    expect(s.expiringWarranties[0]).toMatchObject({ name: 'A', daysLeft: 10 });
    expect(s.recentAssignments[0]).toMatchObject({ assignee: 'EmpA Tester', status: 'ACTIVE' });
  });

  it('is scoped to what the viewer may see, and hides money from people without report access', async () => {
    const asset = await mk('admin', { purchase: { cost: 999 } });
    await mk('admin', { purchase: { cost: 1 } });
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);

    const managerView = (await as('manager').get(api('/summary')).expect(200)).body;
    expect(managerView.purchaseValue).toBeNull();
    expect(managerView.valueByCategory).toBeNull();
    expect(managerView.totals.total).toBe(2); // the held asset (their report) + the assignable pool item
    const hrView = (await as('hr').get(api('/summary')).expect(200)).body;
    expect(hrView.purchaseValue.byCurrency[0]).toMatchObject({ currency: 'INR', total: 1000 });
    expect((await as('adminB').get(api('/summary')).expect(200)).body.totals.total).toBe(0);
  });

  it('exports CSV with formula injection neutralised and only the viewer\'s organization', async () => {
    await mk('admin', { name: '=HYPERLINK("http://evil","x")' });
    await as('adminB').post(api()).send({ name: 'Globex secret', categoryId: (await as('adminB').get(api('/categories'))).body.categories[0].id }).expect(201);
    const res = await as('admin').get(api('/export')).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).not.toContain('Globex secret');
    expect(res.text.split('\r\n')[0]).toContain('Asset ID');
  });
});

describe('organization isolation and blocked users', () => {
  it('another organization cannot read or change assets, whatever ids it uses', async () => {
    const asset = await mk();
    const foreignUser = String(users.empOtherOrg._id);
    const calls = [
      () => as('adminB').get(api(`/${asset.id}`)),
      () => as('adminB').patch(api(`/${asset.id}`)).send({ name: 'pwned' }),
      () => as('adminB').delete(api(`/${asset.id}`)),
      () => as('adminB').post(api(`/${asset.id}/assign`)).send({ userId: foreignUser }),
      () => as('adminB').post(api(`/${asset.id}/return`)).send({}),
      () => as('adminB').post(api(`/${asset.id}/retire`)).send({}),
      () => as('adminB').get(api(`/${asset.id}/assignments`)),
      () => as('adminB').get(api(`/${asset.id}/activity`)),
      () => as('adminB').get(api(`/${asset.id}/maintenance`)),
      () => as('adminB').post(api(`/${asset.id}/maintenance`)).send({ issue: 'x', scheduledDate: '2027-01-01' }),
      () => as('adminB').get(api(`/${asset.id}/documents`)),
    ];
    for (const call of calls) {
      // eslint-disable-next-line no-await-in-loop
      expect((await call()).status).toBe(404);
    }
    expect((await as('adminB').get(api()).expect(200)).body.assets).toEqual([]);
    expect(await Asset.findById(asset.id)).toMatchObject({ name: 'ThinkPad X1', status: 'AVAILABLE' });
  });

  it('cannot assign an asset to a person from another organization (or one that does not exist)', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: String(users.empOtherOrg._id) }).expect(404);
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: String(oid()) }).expect(404);
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: 'nope' }).expect(400);
    await as('admin').post(api(`/${asset.id}/assign`)).send({ assigneeType: 'team', teamId: String((await Team.create({ organization: orgB._id, name: 'Foreign', members: [] }))._id) }).expect(404);
    expect(await AssetAssignment.countDocuments()).toBe(0);
    expect((await Asset.findById(asset.id)).status).toBe('AVAILABLE');
  });

  it('treats malformed ids as missing', async () => {
    await as('admin').get(api('/not-an-id')).expect(404);
    await as('admin').post(api('/not-an-id/assign')).send({ userId: String(users.empA._id) }).expect(404);
  });

  it('refuses organization-blocked users on every asset route', async () => {
    const asset = await mk();
    await as('admin').post(api(`/${asset.id}/assign`)).send({ userId: users.empA._id.toString() }).expect(201);
    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    for (const call of [
      () => as('empA').get(api('/mine')), () => as('empA').get(api(`/${asset.id}`)), () => as('empA').post(api(`/${asset.id}/report-issue`)).send({ issue: 'It is broken' }),
      () => as('empA').get(api(`/${asset.id}/documents`)),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORG_BLOCKED');
    }
  });

  it('requires authentication', async () => {
    const request = require('supertest');
    const { app } = createHarness();
    await request(app).get(api()).expect(401);
    await request(app).get(api('/mine')).expect(401);
  });
});
