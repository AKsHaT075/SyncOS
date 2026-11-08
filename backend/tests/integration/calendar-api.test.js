jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(),
  sendMeetingRequestDecisionEmail: jest.fn(),
}));

const mongoose = require('mongoose');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const AuditLog = require('../../src/models/AuditLog');
const CalendarEvent = require('../../src/models/CalendarEvent');
const Meeting = require('../../src/models/Meeting');
const Notification = require('../../src/models/Notification');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Task = require('../../src/models/Task');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');

const { users, createUser, makeAgent, as } = createHarness();

let orgA;
let orgB;
let eng; // team led by `manager`
let design; // team led by `manager2`
let apollo; // project owned by `manager`, belongs to Eng
let gemini; // project nobody in the main cast belongs to
const oid = () => new mongoose.Types.ObjectId();
const NY = 'America/New_York';

const get = (key, query = {}) => {
  const params = new URLSearchParams({ fromDate: '2026-03-01', toDate: '2026-03-31', tz: 'UTC', ...query });
  return as(key).get(`/api/v1/calendar?${params}`);
};
const items = async (key, query) => (await get(key, query).expect(200)).body.items;
const titles = async (key, query) => (await items(key, query)).map((i) => i.title).sort();
const create = (key, body) => as(key).post('/api/v1/calendar/events').send(body);
const JUNE = { fromDate: '2026-06-01', toDate: '2026-06-30' };
const personal = (overrides = {}) => ({ title: 'Dentist', type: 'personal', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', ...overrides });

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all([Notification.init(), CalendarEvent.init()]);
  await Promise.all(['admin', 'hr', 'manager', 'manager2', 'empA', 'empB', 'empC', 'guest', 'adminB', 'empOtherOrg'].map(makeAgent));
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
  const client = createRedisClient();
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);

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

  eng = await Team.create({ organization: orgA._id, name: 'Engineering', lead: users.manager._id, members: [users.manager._id, users.empA._id] });
  design = await Team.create({ organization: orgA._id, name: 'Design', lead: users.manager2._id, members: [users.manager2._id] });
  apollo = await Project.create({
    organization: orgA._id, owner: users.manager._id, createdBy: users.manager._id, name: 'Apollo', slug: 'apollo', visibility: 'Private',
    team: eng._id, status: 'Active', dueDate: new Date('2026-06-20'),
    members: [
      { user: users.manager._id, role: 'Owner' },
      { user: users.empA._id, role: 'Contributor' },
      { user: users.empB._id, role: 'Contributor' },
      { user: users.guest._id, role: 'Viewer' },
    ],
  });
  gemini = await Project.create({
    organization: orgA._id, owner: users.manager2._id, createdBy: users.manager2._id, name: 'Gemini', slug: 'gemini', visibility: 'Private',
    status: 'Active', dueDate: new Date('2026-06-25'), members: [{ user: users.manager2._id, role: 'Owner' }],
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('creating events', () => {
  it('creates a personal event, converting the wall-clock time in the event\'s zone to UTC', async () => {
    const res = await create('empA', personal({ start: '2026-03-10T09:00', end: '2026-03-10T10:30', timezone: NY })).expect(201);
    const { event } = res.body;
    expect(event).toMatchObject({
      title: 'Dentist', type: 'personal', visibility: 'participants', timezone: NY, allDay: false,
      start: '2026-03-10T13:00:00.000Z', end: '2026-03-10T14:30:00.000Z', // New York is on EDT (UTC-4) from Mar 8
      startLocal: '2026-03-10T09:00', endLocal: '2026-03-10T10:30',
      isOwner: true, canManage: true, recurring: false, recurrence: null,
    });
    expect(event.owner.name).toBe('EmpA Tester');
    expect(await CalendarEvent.countDocuments()).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'calendar_event.created', entityId: event.id })).toBe(1);
  });

  it('accepts absolute instants too, and uses the user\'s own zone when none is given', async () => {
    await as('empA').put('/api/v1/calendar/preferences').send({ timezone: 'Asia/Tokyo' }).expect(200);
    const instant = await create('empA', personal({ timezone: undefined, start: '2026-03-10T00:00:00Z', end: '2026-03-10T01:00:00Z' })).expect(201);
    expect(instant.body.event).toMatchObject({ timezone: 'Asia/Tokyo', start: '2026-03-10T00:00:00.000Z', startLocal: '2026-03-10T09:00' });
  });

  it('creates an all-day event as floating dates (end date inclusive, stored exclusive)', async () => {
    const res = await create('empA', { title: 'Offsite', type: 'personal', allDay: true, start: '2026-03-10', end: '2026-03-12', timezone: NY }).expect(201);
    expect(res.body.event).toMatchObject({ allDay: true, startDate: '2026-03-10', endDate: '2026-03-12', start: null, end: null });
    const stored = await CalendarEvent.findOne();
    expect(stored.start.toISOString()).toBe('2026-03-10T00:00:00.000Z'); // UTC midnight, never shifted
    expect(stored.end.toISOString()).toBe('2026-03-13T00:00:00.000Z');
  });

  it('validates input', async () => {
    const bad = async (body, code) => {
      const res = await create('empA', body).expect(400);
      if (code) expect(res.body.code).toBe(code);
    };
    await bad(personal({ end: '2026-03-10T09:00' }), 'INVALID_TIME_RANGE'); // not after start
    await bad(personal({ end: '2026-03-10T08:00' }), 'INVALID_TIME_RANGE');
    await bad(personal({ timezone: 'Mars/Base' }), 'INVALID_TIMEZONE');
    await bad(personal({ start: 'tomorrow' }), 'VALIDATION_ERROR');
    await bad(personal({ start: '2026-02-30T09:00' }), 'INVALID_DATE');
    await bad(personal({ start: '1960-01-01T09:00', end: '1960-01-01T10:00' }), 'INVALID_DATE');
    await bad(personal({ start: '2026-03-10T09:00', end: '2028-03-10T09:00' }), 'INVALID_TIME_RANGE'); // > a year
    await bad(personal({ title: '   ' }));
    await bad(personal({ meetingUrl: 'javascript:alert(1)' }));
    await bad(personal({ reminders: Array.from({ length: 6 }, (_, i) => ({ minutesBefore: i + 1 })) }));
    await bad(personal({ reminders: [{ minutesBefore: 0 }] }));
    await bad(personal({ reminders: [{ minutesBefore: 99999 }] }));
    await bad(personal({ organization: 'x' })); // unknown field
    await bad(personal({ type: 'meeting' }));
    await bad(personal({ allDay: true, start: '2026-03-10T09:00', end: '2026-03-10' }), 'INVALID_DATE');
    await bad(personal({ allDay: true, start: '2026-03-12', end: '2026-03-10' }), 'INVALID_TIME_RANGE');
    await bad(personal({ visibility: 'organization' }), 'INVALID_VISIBILITY');
    await bad(personal({ teamId: eng._id.toString() }), 'INVALID_TEAM');
    expect(await CalendarEvent.countDocuments()).toBe(0);
  });

  it('de-duplicates reminders and keeps their email flags', async () => {
    const res = await create('empA', personal({ reminders: [{ minutesBefore: 15 }, { minutesBefore: 5, email: true }, { minutesBefore: 15, email: true }] })).expect(201);
    expect(res.body.event.reminders).toEqual([{ minutesBefore: 5, email: true }, { minutesBefore: 15, email: true }]);
  });

  it('validates recurrence rules', async () => {
    const withRule = (recurrence) => create('empA', personal({ recurrence }));
    expect((await withRule({ freq: 'daily', until: '2026-04-01', count: 3 }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    await withRule({ freq: 'daily', byWeekday: [1] }).expect(400); // weekdays only for weekly
    await withRule({ freq: 'weekly', monthly: { mode: 'date', day: 5 } }).expect(400);
    await withRule({ freq: 'daily', interval: 0 }).expect(400);
    await withRule({ freq: 'daily', count: 5000 }).expect(400);
    await withRule({ freq: 'yearly' }).expect(400); // not supported in v1
    await withRule({ freq: 'monthly', monthly: { mode: 'nthWeekday', nth: 5, weekday: 1 } }).expect(400);
    // The first date must itself match the rule (2026-03-10 is a Tuesday).
    expect((await withRule({ freq: 'weekly', byWeekday: [1] }).expect(400)).body.code).toBe('INVALID_RECURRENCE');
    expect((await withRule({ freq: 'weekly', byWeekday: [2], until: '2026-03-01' }).expect(400)).body.code).toBe('INVALID_RECURRENCE');
    await withRule({ freq: 'weekly', byWeekday: [2, 4], count: 4 }).expect(201);
  });

  it('rejects attendees from another organization, blocked, deactivated or unknown users', async () => {
    await User.updateOne({ _id: users.empC._id }, { orgBlocked: true });
    await User.updateOne({ _id: users.empB._id }, { isActive: false });
    for (const attendee of [users.empOtherOrg._id, users.empC._id, users.empB._id, oid()]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await create('empA', personal({ attendees: [attendee.toString()] }));
      expect(res.status).toBe(404);
    }
    await create('empA', personal({ attendees: ['nope'] })).expect(400); // not even a valid id
    expect(await CalendarEvent.countDocuments()).toBe(0);
  });

  it('requires authentication, CSRF, and the CREATE_EVENT permission (guests are read-only)', async () => {
    const request = require('supertest');
    const { app } = createHarness();
    await request(app).get('/api/v1/calendar?fromDate=2026-03-01&toDate=2026-03-31').expect(401);
    await request(app).post('/api/v1/calendar/events').send(personal()).expect(403); // CSRF is checked before auth on writes
    const res = await create('guest', personal()).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('who may create which kind of event', () => {
  const team = (teamId, extra = {}) => ({ title: 'Team sync', type: 'team', teamId: teamId.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', ...extra });
  const organization = () => ({ title: 'All hands', type: 'organization', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' });

  it('team events: org admin / HR for any team; a manager ONLY for a team they lead; employees never', async () => {
    await create('admin', team(eng._id)).expect(201);
    await create('hr', team(design._id)).expect(201);
    await create('manager', team(eng._id)).expect(201); // leads Engineering
    await create('manager2', team(design._id)).expect(201); // leads Design

    expect((await create('manager', team(design._id)).expect(403)).body.code).toBe('FORBIDDEN'); // leads Eng, not Design
    await create('manager2', team(eng._id)).expect(403);
    await create('empA', team(eng._id)).expect(403); // a member, not a manager
    await create('guest', team(eng._id)).expect(403);
    await create('manager', { ...team(eng._id), teamId: undefined }).expect(400); // needs a team
    await create('admin', team(oid())).expect(404);
    await create('admin', team(eng._id, { visibility: 'organization' })).expect(400);
  });

  it('a manager who stops leading a team can no longer create events for it', async () => {
    await create('manager', team(eng._id)).expect(201);
    await Team.updateOne({ _id: eng._id }, { lead: users.manager2._id });
    await create('manager', team(eng._id)).expect(403);
  });

  it('organization events: org admin and HR only', async () => {
    await create('admin', organization()).expect(201);
    await create('hr', organization()).expect(201);
    for (const key of ['manager', 'manager2', 'empA', 'guest']) {
      // eslint-disable-next-line no-await-in-loop
      await create(key, organization()).expect(403);
    }
  });

  it('project-linked events: the project\'s owner/manager or an org admin; others cannot', async () => {
    const linked = { title: 'Kickoff', type: 'general', visibility: 'project', projectId: apollo._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' };
    await create('manager', linked).expect(201); // project owner
    await create('admin', linked).expect(201);
    await create('empA', linked).expect(403); // contributor
    await create('empC', linked).expect(403); // not a member
    await create('manager', { ...linked, projectId: gemini._id.toString() }).expect(403); // someone else's project
    await create('manager', { ...linked, projectId: undefined }).expect(400);
    await create('manager', { ...linked, type: 'personal' }).expect(400);
    await create('adminB', { ...linked }).expect(404); // other organization's project id
  });

  it('plain general events need no special rights', async () => {
    await create('empC', { title: 'Lunch', type: 'general', start: '2026-03-10T12:00', end: '2026-03-10T13:00', timezone: 'UTC', attendees: [users.empA._id.toString()] }).expect(201);
  });
});

describe('date-range retrieval', () => {
  beforeEach(async () => {
    await create('empA', personal({ title: 'Early', start: '2026-03-05T09:00', end: '2026-03-05T10:00' })).expect(201);
    await create('empA', personal({ title: 'Late', start: '2026-03-28T09:00', end: '2026-03-28T10:00' })).expect(201);
    await create('empA', personal({ title: 'Outside', start: '2026-05-05T09:00', end: '2026-05-05T10:00' })).expect(201);
  });

  it('returns only events overlapping the requested days', async () => {
    expect(await titles('empA')).toEqual(['Early', 'Late']);
    expect(await titles('empA', { fromDate: '2026-05-01', toDate: '2026-05-31' })).toEqual(['Outside']);
    expect(await titles('empA', { fromDate: '2026-03-06', toDate: '2026-03-27' })).toEqual([]);
  });

  it('includes events that start before the window but run into it, and excludes ones that end exactly at its start', async () => {
    await create('empA', personal({ title: 'Overnight', start: '2026-04-30T22:00', end: '2026-05-01T02:00' })).expect(201);
    await create('empA', personal({ title: 'Ends at midnight', start: '2026-04-30T22:00', end: '2026-05-01T00:00' })).expect(201);
    const may = await titles('empA', { fromDate: '2026-05-01', toDate: '2026-05-31' });
    expect(may).toContain('Overnight');
    expect(may).not.toContain('Ends at midnight');
  });

  it('interprets the requested days in the viewer\'s timezone', async () => {
    // 23:30 UTC on Mar 10 is already Mar 11 in Tokyo and still Mar 10 in New York.
    await create('empA', personal({ title: 'Late night', start: '2026-03-10T23:30:00Z', end: '2026-03-11T00:30:00Z' })).expect(201);
    const day = (tz, date) => titles('empA', { fromDate: date, toDate: date, tz });
    expect(await day('Asia/Tokyo', '2026-03-11')).toContain('Late night');
    expect(await day('Asia/Tokyo', '2026-03-10')).not.toContain('Late night');
    expect(await day(NY, '2026-03-10')).toContain('Late night');
    expect(await day(NY, '2026-03-11')).toEqual([]);
  });

  it('reports the resolved timezone, falling back user → organization → IST', async () => {
    const plain = (await get('empA', { tz: undefined }).expect(200)).body;
    expect(plain).toMatchObject({ timeZone: 'Asia/Kolkata', timeZoneSource: 'default' }); // IST unless someone chose otherwise

    await Organization.updateOne({ _id: orgA._id }, { 'settings.timezone': 'Europe/Berlin' });
    expect((await get('empA', { tz: undefined }).expect(200)).body).toMatchObject({ timeZone: 'Europe/Berlin', timeZoneSource: 'organization' });

    await as('empA').put('/api/v1/calendar/preferences').send({ timezone: 'Asia/Kolkata' }).expect(200);
    expect((await get('empA', { tz: undefined }).expect(200)).body).toMatchObject({ timeZone: 'Asia/Kolkata', timeZoneSource: 'user' });
    expect((await get('empB', { tz: undefined }).expect(200)).body.timeZone).toBe('Europe/Berlin'); // another user is unaffected
    expect((await get('empA', { tz: 'Not/AZone' }).expect(200)).body.timeZone).toBe('Asia/Kolkata'); // bad override ignored
  });

  it('rejects bad or oversized ranges and unknown parameters', async () => {
    await get('empA', { fromDate: '2026-03-10', toDate: '2026-03-01' }).expect(400);
    expect((await get('empA', { fromDate: '2026-01-01', toDate: '2026-06-30' }).expect(400)).body.code).toBe('RANGE_TOO_LARGE');
    await get('empA', { fromDate: 'soon' }).expect(400);
    await get('empA', { organization: 'x' }).expect(400);
    await get('empA', { types: 'event,bogus' }).expect(400);
    await get('empA', { scope: 'galaxy' }).expect(400);
  });

  it('an all-day event spanning days appears with its inclusive dates', async () => {
    await create('empA', { title: 'Offsite', type: 'personal', allDay: true, start: '2026-03-12', end: '2026-03-14', timezone: NY }).expect(201);
    const [offsite] = (await items('empA')).filter((i) => i.title === 'Offsite');
    expect(offsite).toMatchObject({ allDay: true, startDate: '2026-03-12', endDate: '2026-03-14', start: null });
    expect(await titles('empA', { fromDate: '2026-03-14', toDate: '2026-03-14' })).toEqual(['Offsite']);
    expect(await titles('empA', { fromDate: '2026-03-15', toDate: '2026-03-15' })).toEqual([]);
  });
});

describe('editing and deleting', () => {
  const makeEvent = async (key = 'empA', body = personal()) => (await create(key, body).expect(201)).body.event;
  const patch = (key, id, body) => as(key).patch(`/api/v1/calendar/events/${id}`).send(body);

  it('the owner edits fields; moving only the start keeps the duration', async () => {
    const event = await makeEvent('empA', personal({ start: '2026-03-10T09:00', end: '2026-03-10T10:30' }));
    const res = await patch('empA', event.id, { title: 'Dentist (moved)', start: '2026-03-11T14:00', location: 'Clinic' }).expect(200);
    expect(res.body.event).toMatchObject({
      title: 'Dentist (moved)', location: 'Clinic', startLocal: '2026-03-11T14:00', endLocal: '2026-03-11T15:30',
    });
    expect(await AuditLog.countDocuments({ action: 'calendar_event.updated' })).toBe(1);
  });

  it('editing never shifts the time: re-saving the displayed local values is a no-op', async () => {
    const event = await makeEvent('empA', personal({ start: '2026-03-08T03:30', end: '2026-03-08T04:30', timezone: NY })); // across spring-forward
    const before = await CalendarEvent.findById(event.id).lean();
    await patch('empA', event.id, { start: event.startLocal, end: event.endLocal, timezone: NY }).expect(200);
    const after = await CalendarEvent.findById(event.id).lean();
    expect(after.start.getTime()).toBe(before.start.getTime());
    expect(after.end.getTime()).toBe(before.end.getTime());
  });

  it('switching between timed and all-day requires both dates', async () => {
    const event = await makeEvent();
    expect((await patch('empA', event.id, { allDay: true }).expect(400)).body.code).toBe('INVALID_TIME_RANGE');
    const res = await patch('empA', event.id, { allDay: true, start: '2026-03-10', end: '2026-03-10' }).expect(200);
    expect(res.body.event).toMatchObject({ allDay: true, startDate: '2026-03-10', endDate: '2026-03-10' });
  });

  it('rejects empty updates, unknown fields and attempts to change type/team/project', async () => {
    const event = await makeEvent();
    await patch('empA', event.id, {}).expect(400);
    await patch('empA', event.id, { type: 'organization' }).expect(400);
    await patch('empA', event.id, { teamId: eng._id.toString() }).expect(400);
    await patch('empA', event.id, { owner: users.empB._id.toString() }).expect(400);
    await patch('empA', event.id, { end: '2026-03-10T08:00' }).expect(400);
  });

  it('only the owner can modify a personal/general event; others get 403 (visible) or 404 (hidden)', async () => {
    const shared = await makeEvent('empA', { title: 'Shared', type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', attendees: [users.empB._id.toString()] });
    await patch('empB', shared.id, { title: 'hijack' }).expect(403); // an attendee can see it but not manage it
    await as('empB').delete(`/api/v1/calendar/events/${shared.id}`).expect(403);
    await patch('empC', shared.id, { title: 'hijack' }).expect(404); // can't even see it
    await as('empC').delete(`/api/v1/calendar/events/${shared.id}`).expect(404);
    await patch('admin', shared.id, { title: 'by admin' }).expect(200); // admins manage non-personal events
    expect((await CalendarEvent.findById(shared.id)).title).toBe('by admin');
  });

  it('personal events are private even from org admins', async () => {
    const mine = await makeEvent('empA');
    await as('admin').get(`/api/v1/calendar/events/${mine.id}`).expect(404);
    await patch('admin', mine.id, { title: 'x' }).expect(404);
    await as('admin').delete(`/api/v1/calendar/events/${mine.id}`).expect(404);
    expect(await titles('admin')).toEqual([]);
  });

  it('team events are managed by the CURRENT team lead / org admin / HR, not by whoever created them', async () => {
    const event = (await create('manager', { title: 'Team sync', type: 'team', teamId: eng._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201)).body.event;
    await patch('manager2', event.id, { title: 'x' }).expect(404); // manager2 is not on Engineering: can't even see it
    await patch('empA', event.id, { title: 'x' }).expect(403); // a member can see it but not manage it
    await patch('hr', event.id, { title: 'by hr' }).expect(200);

    await Team.updateOne({ _id: eng._id }, { lead: users.manager2._id }); // leadership changes hands
    // The creator can still SEE their event, but no longer MANAGE it: authority follows current leadership.
    await as('manager').get(`/api/v1/calendar/events/${event.id}`).expect(200);
    await patch('manager', event.id, { title: 'still mine?' }).expect(403);
    await patch('manager2', event.id, { title: 'by the new lead' }).expect(200);
  });

  it('deleting a series removes it from every view (soft delete)', async () => {
    const event = await makeEvent();
    await as('empA').delete(`/api/v1/calendar/events/${event.id}`).expect(200);
    expect(await titles('empA')).toEqual([]);
    await as('empA').get(`/api/v1/calendar/events/${event.id}`).expect(404);
    expect(await CalendarEvent.findById(event.id)).toMatchObject({ status: 'cancelled' });
    expect(await CalendarEvent.findById(event.id).then((e) => e.deletedAt)).toBeInstanceOf(Date);
    await as('empA').delete(`/api/v1/calendar/events/${event.id}`).expect(404);
    expect(await AuditLog.countDocuments({ action: 'calendar_event.deleted' })).toBe(1);
  });

  it('malformed ids are 404', async () => {
    await as('empA').get('/api/v1/calendar/events/not-an-id').expect(404);
    await patch('empA', 'not-an-id', { title: 'x' }).expect(404);
  });
});

describe('recurring events', () => {
  // Weekly Monday 09:00 New York, starting Mon 2 Mar 2026 — spans the 8 Mar spring-forward.
  const weekly = (overrides = {}) => ({
    title: 'Standup', type: 'general', start: '2026-03-02T09:00', end: '2026-03-02T09:30', timezone: NY,
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] }, ...overrides,
  });
  const standup = async (overrides) => (await create('empA', weekly(overrides)).expect(201)).body.event;
  const occurrences = async (key = 'empA', query = {}) => (await items(key, { fromDate: '2026-03-01', toDate: '2026-04-05', tz: NY, ...query })).filter((i) => i.title.startsWith('Stand') || i.modified || i.eventId);

  it('expands a series inside the window, with stable occurrence ids and DST-correct instants', async () => {
    const event = await standup();
    expect(event).toMatchObject({ recurring: true, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: null, until: null } });

    const list = await occurrences();
    expect(list).toHaveLength(5); // Mar 2, 9, 16, 23, 30
    expect(list.map((i) => i.id)).toEqual(list.map((i) => `event:${event.id}:${new Date(i.start).getTime()}`));
    expect(list.map((i) => i.start)).toEqual([
      '2026-03-02T14:00:00.000Z', // EST
      '2026-03-09T13:00:00.000Z', // EDT: 09:00 local stays 09:00, the UTC instant moves
      '2026-03-16T13:00:00.000Z', '2026-03-23T13:00:00.000Z', '2026-03-30T13:00:00.000Z',
    ]);
    list.forEach((i) => expect(i).toMatchObject({ recurring: true, occurrenceStart: expect.any(Number), eventId: event.id }));

    // Moving the window does not change an occurrence's identity.
    const later = await occurrences('empA', { fromDate: '2026-03-15', toDate: '2026-04-30' });
    const shared = later.filter((i) => list.some((o) => o.id === i.id));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('stays bounded: a far-away window returns only that window, and a count/until ends the series', async () => {
    await standup({ title: 'Forever' });
    const far = await items('empA', { fromDate: '2030-06-03', toDate: '2030-06-16', tz: NY });
    expect(far.map((i) => i.title)).toEqual(['Forever', 'Forever']); // two Mondays, nothing generated beforehand
    expect(await CalendarEvent.countDocuments()).toBe(1);

    await standup({ title: 'Limited', recurrence: { freq: 'weekly', byWeekday: [1], count: 3 } });
    await standup({ title: 'Until', recurrence: { freq: 'weekly', byWeekday: [1], until: '2026-03-16' } });
    const all = await items('empA', { fromDate: '2026-03-01', toDate: '2026-05-31', tz: NY });
    expect(all.filter((i) => i.title === 'Limited')).toHaveLength(3);
    expect(all.filter((i) => i.title === 'Until')).toHaveLength(3); // Mar 2, 9, 16 (inclusive)
  });

  it('supports every-N-months and monthly by Nth weekday through the API', async () => {
    await create('empA', { title: 'Review', type: 'general', start: '2026-01-13T10:00', end: '2026-01-13T11:00', timezone: 'UTC', recurrence: { freq: 'monthly', interval: 1, monthly: { mode: 'nthWeekday', nth: 2, weekday: 2 } } }).expect(201);
    await create('empA', { title: 'Quarterly', type: 'general', start: '2026-01-15T10:00', end: '2026-01-15T11:00', timezone: 'UTC', recurrence: { freq: 'monthly', interval: 3, monthly: { mode: 'date', day: 15 } } }).expect(201);
    const all = await items('empA', { fromDate: '2026-02-01', toDate: '2026-04-30', tz: 'UTC' });
    expect(all.filter((i) => i.title === 'Review').map((i) => i.start.slice(0, 10))).toEqual(['2026-02-10', '2026-03-10', '2026-04-14']);
    expect(all.filter((i) => i.title === 'Quarterly').map((i) => i.start.slice(0, 10))).toEqual(['2026-04-15']);
  });

  it('recurring all-day events repeat on the same calendar dates', async () => {
    await create('empA', { title: 'Payday', type: 'personal', allDay: true, start: '2026-03-06', end: '2026-03-06', timezone: NY, recurrence: { freq: 'daily', interval: 1, count: 5 } }).expect(201);
    const days = (await items('empA', { tz: 'Pacific/Kiritimati' })).filter((i) => i.title === 'Payday').map((i) => i.startDate);
    expect(days).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('editing ONE occurrence overrides it without disturbing the series or its id', async () => {
    const event = await standup();
    const target = (await occurrences())[2]; // Mar 16
    const res = await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({
      scope: 'occurrence', occurrenceStart: String(target.occurrenceStart), title: 'Standup (workshop)', start: '2026-03-16T11:00', end: '2026-03-16T12:00',
    }).expect(200);
    expect(res.body.event.exceptionCount).toBe(1);

    const list = await occurrences();
    expect(list).toHaveLength(5);
    const edited = list.find((i) => i.id === target.id);
    expect(edited).toMatchObject({ title: 'Standup (workshop)', modified: true, start: '2026-03-16T15:00:00.000Z', end: '2026-03-16T16:00:00.000Z' });
    expect(list.filter((i) => i.title === 'Standup')).toHaveLength(4); // the rest of the series is untouched
    expect((await CalendarEvent.findById(event.id)).title).toBe('Standup');
  });

  it('a single occurrence moved INTO a window shows up even though its original slot is outside it', async () => {
    const event = await standup({ recurrence: { freq: 'weekly', byWeekday: [1], count: 4 } });
    const march9 = (await occurrences()).find((i) => i.start.startsWith('2026-03-09'));
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({
      scope: 'occurrence', occurrenceStart: String(march9.occurrenceStart), start: '2026-04-20T09:00', end: '2026-04-20T09:30',
    }).expect(200);
    const april = await items('empA', { fromDate: '2026-04-19', toDate: '2026-04-25', tz: NY });
    expect(april).toHaveLength(1);
    expect(april[0].id).toBe(march9.id); // identity is still the ORIGINAL slot
    expect((await occurrences()).some((i) => i.start.startsWith('2026-03-09'))).toBe(false);
  });

  it('deleting ONE occurrence removes only it; deleting the series removes everything', async () => {
    const event = await standup();
    const target = (await occurrences())[1];
    await as('empA').delete(`/api/v1/calendar/events/${event.id}?scope=occurrence&occurrenceStart=${target.occurrenceStart}`).expect(200);
    const list = await occurrences();
    expect(list).toHaveLength(4);
    expect(list.some((i) => i.id === target.id)).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'calendar_event.occurrence_cancelled' })).toBe(1);

    await as('empA').delete(`/api/v1/calendar/events/${event.id}`).expect(200);
    expect(await occurrences()).toHaveLength(0);
  });

  it('refuses occurrences the series never produces, and occurrence scope on a one-off event', async () => {
    const event = await standup();
    const patchOcc = (body) => as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ scope: 'occurrence', ...body });
    expect((await patchOcc({ occurrenceStart: String(Date.UTC(2026, 2, 3, 14)), title: 'x' }).expect(400)).body.code).toBe('INVALID_OCCURRENCE'); // a Tuesday
    expect((await patchOcc({ title: 'x' }).expect(400)).body.code).toBe('OCCURRENCE_REQUIRED');
    expect((await patchOcc({ occurrenceStart: 'garbage', title: 'x' }).expect(400)).body.code).toBe('INVALID_OCCURRENCE');
    await as('empA').delete(`/api/v1/calendar/events/${event.id}?scope=occurrence&occurrenceStart=${Date.UTC(2026, 2, 3, 14)}`).expect(400);

    const target = (await occurrences())[0];
    expect((await patchOcc({ occurrenceStart: String(target.occurrenceStart), attendees: [users.empB._id.toString()] }).expect(400)).body.code).toBe('OCCURRENCE_FIELD_NOT_ALLOWED');
    await patchOcc({ occurrenceStart: String(target.occurrenceStart), recurrence: null }).expect(400);

    const oneOff = (await create('empA', personal()).expect(201)).body.event;
    expect((await as('empA').patch(`/api/v1/calendar/events/${oneOff.id}`).send({ scope: 'occurrence', occurrenceStart: '1700000000000', title: 'x' }).expect(400)).body.code).toBe('NOT_RECURRING');
  });

  it('editing the series keeps exceptions when only text changes, but clears them when the schedule changes', async () => {
    const event = await standup();
    const target = (await occurrences())[1];
    await as('empA').delete(`/api/v1/calendar/events/${event.id}?scope=occurrence&occurrenceStart=${target.occurrenceStart}`).expect(200);

    const renamed = await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ title: 'Daily standup' }).expect(200);
    expect(renamed.body.event.exceptionCount).toBe(1);
    expect((await occurrences()).length).toBe(4);

    const rescheduled = await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ start: '2026-03-02T10:00', end: '2026-03-02T10:30' }).expect(200);
    expect(rescheduled.body.event.exceptionCount).toBe(0); // old exceptions referred to the old schedule
    expect((await occurrences()).length).toBe(5);
  });

  it('the series can be made non-recurring, or have its rule changed', async () => {
    const event = await standup();
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ recurrence: { freq: 'daily', interval: 7, count: 2 } }).expect(200);
    expect((await occurrences()).length).toBe(2);
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ recurrence: null }).expect(200);
    expect((await occurrences()).length).toBe(1);
  });
});

describe('meetings are integrated, never duplicated', () => {
  const inMinutes = (m) => new Date(Date.now() + m * 60000);
  const makeMeeting = (overrides = {}) =>
    Meeting.create({
      organization: orgA._id, project: apollo._id, topic: 'Sprint planning', type: 'Scheduled', status: 'Scheduled',
      startTime: new Date('2026-03-12T15:00:00Z'), endTime: new Date('2026-03-12T16:30:00Z'),
      host: users.manager._id, createdBy: users.manager._id,
      participants: [
        { user: users.manager._id, role: 'Host', status: 'Accepted' },
        { user: users.empA._id, role: 'Participant', status: 'Invited' },
      ],
      ...overrides,
    });

  it('appears automatically for participants, read-only, linking to the meeting page', async () => {
    const meeting = await makeMeeting();
    const [item] = await items('empA');
    expect(item).toMatchObject({
      id: `meeting:${meeting._id}`, source: 'meeting', category: 'meeting', title: 'Sprint planning', readOnly: true,
      start: '2026-03-12T15:00:00.000Z', end: '2026-03-12T16:30:00.000Z', status: 'Scheduled', participantCount: 2,
      project: { id: apollo._id.toString(), name: 'Apollo' }, link: `/dashboard/projects/${apollo._id}/meetings/${meeting._id}`,
    });
    expect(item.participants.map((p) => p.name).sort()).toEqual(['EmpA Tester', 'Manager Tester']);
    expect(await CalendarEvent.countDocuments()).toBe(0); // nothing was copied
  });

  it('follows meeting updates and shows cancellations only when asked', async () => {
    const meeting = await makeMeeting();
    expect((await items('empA'))[0].start).toBe('2026-03-12T15:00:00.000Z');
    await Meeting.updateOne({ _id: meeting._id }, { startTime: new Date('2026-03-13T10:00:00Z'), endTime: new Date('2026-03-13T11:00:00Z'), topic: 'Sprint planning (moved)' });
    const [moved] = await items('empA');
    expect(moved).toMatchObject({ title: 'Sprint planning (moved)', start: '2026-03-13T10:00:00.000Z' });
    expect(await items('empA')).toHaveLength(1); // same meeting, no duplicate

    await Meeting.updateOne({ _id: meeting._id }, { status: 'Cancelled', cancelledAt: new Date() });
    expect(await items('empA')).toHaveLength(0);
    const shown = await items('empA', { includeCancelled: 'true' });
    expect(shown).toHaveLength(1);
    expect(shown[0].status).toBe('Cancelled');
    await Meeting.updateOne({ _id: meeting._id }, { deletedAt: new Date() });
    expect(await items('empA', { includeCancelled: 'true' })).toHaveLength(0);
  });

  it('enforces meeting access: only members of the project see it; personal scope also needs participation', async () => {
    await makeMeeting();
    expect(await items('empC')).toHaveLength(0); // not a project member
    expect(await items('empOtherOrg')).toHaveLength(0);
    expect(await items('empB', { scope: 'personal' })).toHaveLength(0); // a member but not invited
    // Project members can access the meeting (as in the Meetings module), so the wider views include it.
    expect(await items('empB', { scope: 'organization' })).toHaveLength(1);
    await get('empB', { scope: 'team', teamId: eng._id.toString() }).expect(403); // empB isn't on Engineering
    expect(await items('admin', { scope: 'organization' })).toHaveLength(1);
    expect(await items('manager', { scope: 'organization' })).toHaveLength(1);
    expect(await items('empC', { scope: 'organization' })).toHaveLength(0);
  });

  it('offers a join link only when joining is permitted and the meeting is live or imminent', async () => {
    const soon = await makeMeeting({ startTime: inMinutes(5), endTime: inMinutes(35) });
    const far = await makeMeeting({ topic: 'Next week', startTime: inMinutes(60 * 24 * 7), endTime: inMinutes(60 * 24 * 7 + 30) });
    const all = await items('empA', { fromDate: '2026-11-01', toDate: '2027-01-31' });
    expect(all.find((i) => i.id === `meeting:${soon._id}`)).toMatchObject({ canJoin: true, joinLink: `/meeting-room/${apollo._id}/${soon._id}` });
    expect(all.find((i) => i.id === `meeting:${far._id}`)).toMatchObject({ canJoin: false, joinLink: null });
    await Meeting.updateOne({ _id: soon._id }, { status: 'Ended' });
    expect((await items('empA', { fromDate: '2026-11-01', toDate: '2027-01-31' })).find((i) => i.id === `meeting:${soon._id}`).canJoin).toBe(false);
  });

  it('shows a meeting without an end time with a default length flag', async () => {
    await makeMeeting({ endTime: null });
    const [item] = await items('empA');
    expect(item.hasEndTime).toBe(false);
    expect(new Date(item.end) - new Date(item.start)).toBe(3600000);
  });

  it('team scope shows meetings of the team\'s projects', async () => {
    await makeMeeting();
    expect(await titles('empA', { scope: 'team', teamId: eng._id.toString() })).toEqual(['Sprint planning']);
    expect(await titles('hr', { scope: 'team', teamId: design._id.toString() })).toEqual([]);
  });
});

describe('tasks are integrated as all-day deadlines', () => {
  const makeTask = (overrides = {}) =>
    Task.create({
      organization: orgA._id, project: apollo._id, title: 'Fix login', owner: users.manager._id, createdBy: users.manager._id,
      assignees: [users.empA._id], visibility: 'Public', status: 'In Progress', priority: 'High', dueDate: new Date('2026-03-20'), ...overrides,
    });

  it('shows assigned tasks with title, status, priority and assignees, linking to the task', async () => {
    const task = await makeTask();
    const [item] = await items('empA');
    expect(item).toMatchObject({
      id: `task:${task._id}`, source: 'task', category: 'task', title: 'Fix login', allDay: true, startDate: '2026-03-20', endDate: '2026-03-20',
      status: 'In Progress', priority: 'High', done: false, readOnly: true,
      project: { id: apollo._id.toString(), name: 'Apollo' }, link: `/dashboard/projects/${apollo._id}/tasks/${task._id}`,
    });
    expect(item.assignees.map((a) => a.name)).toEqual(['EmpA Tester']);
    expect(await CalendarEvent.countDocuments()).toBe(0);
  });

  it('NEVER shifts a due date, whatever timezone the viewer is in', async () => {
    await makeTask();
    for (const tz of ['UTC', 'America/Los_Angeles', NY, 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      // eslint-disable-next-line no-await-in-loop
      const [item] = await items('empA', { tz, fromDate: '2026-03-20', toDate: '2026-03-20' });
      expect(item).toMatchObject({ startDate: '2026-03-20', endDate: '2026-03-20' });
      // eslint-disable-next-line no-await-in-loop
      expect(await items('empA', { tz, fromDate: '2026-03-19', toDate: '2026-03-19' })).toHaveLength(0);
    }
  });

  it('reflects task changes without duplicates, and marks completed/cancelled ones', async () => {
    const task = await makeTask();
    await Task.updateOne({ _id: task._id }, { dueDate: new Date('2026-03-22'), status: 'Completed', title: 'Fix login (done)' });
    const list = await items('empA');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Fix login (done)', startDate: '2026-03-22', status: 'Completed', done: true });
    await Task.updateOne({ _id: task._id }, { status: 'Cancelled' });
    expect((await items('empA'))[0].done).toBe(true);
    await Task.updateOne({ _id: task._id }, { archived: true });
    expect(await items('empA')).toHaveLength(0);
    await Task.updateOne({ _id: task._id }, { archived: false, deletedAt: new Date() });
    expect(await items('empA')).toHaveLength(0);
  });

  it('filters by project, status, assignee and text', async () => {
    await makeTask();
    await makeTask({ title: 'Write docs', assignees: [users.empB._id], status: 'Todo' });
    await makeTask({ title: 'Gemini work', project: gemini._id, assignees: [users.manager2._id], owner: users.manager2._id });
    const team = { scope: 'organization', types: 'task' };
    expect(await titles('admin', team)).toEqual(['Fix login', 'Gemini work', 'Write docs']);
    expect(await titles('admin', { ...team, projectId: apollo._id.toString() })).toEqual(['Fix login', 'Write docs']);
    expect(await titles('admin', { ...team, status: 'todo' })).toEqual(['Write docs']);
    expect(await titles('admin', { ...team, assigneeId: users.empB._id.toString() })).toEqual(['Write docs']);
    expect(await titles('admin', { ...team, q: 'DOCS' })).toEqual(['Write docs']);
    expect(await titles('admin', { ...team, q: '.*' })).toEqual([]); // regex-safe
  });

  it('personal scope is "assigned to me"; private tasks stay private; outsiders see nothing', async () => {
    await makeTask();
    await makeTask({ title: 'Secret plan', visibility: 'Private', assignees: [users.empB._id] });
    expect(await titles('empA')).toEqual(['Fix login']);
    expect(await titles('empB')).toEqual(['Secret plan']);
    // empA is a project member but not attached to the private task: it is invisible even in the wider views.
    expect(await titles('empA', { scope: 'team', teamId: eng._id.toString() })).toEqual(['Fix login']);
    expect(await titles('empC')).toEqual([]);
    expect(await titles('empOtherOrg')).toEqual([]);
    expect(await titles('manager', { scope: 'team', teamId: eng._id.toString() })).toEqual(['Fix login', 'Secret plan']); // project owner sees private tasks
  });

  it('project deadlines appear read-only and all-day, from the Project record', async () => {
    const list = await items('empA', JUNE);
    const deadline = list.find((i) => i.source === 'project');
    expect(deadline).toMatchObject({
      id: `project:${apollo._id}`, title: 'Apollo', allDay: true, startDate: '2026-06-20', readOnly: true, link: `/dashboard/projects/${apollo._id}`,
    });
    expect(list.filter((i) => i.source === 'project')).toHaveLength(1); // Gemini isn't empA's project
    expect((await items('admin', { scope: 'organization', ...JUNE })).filter((i) => i.source === 'project')).toHaveLength(2);
    expect((await items('empC', JUNE)).filter((i) => i.source === 'project')).toHaveLength(0);
    expect((await items('empA', { ...JUNE, types: 'general,meeting,task' })).filter((i) => i.source === 'project')).toHaveLength(0); // legend toggle
    await Project.updateOne({ _id: apollo._id }, { dueDate: new Date('2026-06-27') });
    expect((await items('empA', JUNE)).find((i) => i.source === 'project').startDate).toBe('2026-06-27');
    await Project.updateOne({ _id: apollo._id }, { deletedAt: new Date() });
    expect((await items('empA', JUNE)).filter((i) => i.source === 'project')).toHaveLength(0);
  });
});

describe('calendar scopes', () => {
  const mk = (key, body) => create(key, { type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', ...body }).expect(201);

  it('team calendar: members, the team lead, HR and org admins only; needs a team', async () => {
    const q = (team) => ({ scope: 'team', teamId: team._id.toString() });
    await get('empA', q(eng)).expect(200);
    await get('manager', q(eng)).expect(200);
    await get('hr', q(eng)).expect(200);
    await get('admin', q(design)).expect(200);
    expect((await get('empA', q(design)).expect(403)).body.code).toBe('FORBIDDEN');
    await get('empC', q(eng)).expect(403);
    await get('guest', q(eng)).expect(403);
    await get('empA', { scope: 'team' }).expect(400);
    await get('empA', { scope: 'team', teamId: oid().toString() }).expect(404);
    await get('adminB', q(eng)).expect(404); // another organization's team
  });

  it('team calendar shows team events and project events of the team\'s projects', async () => {
    await create('manager', { title: 'Eng sync', type: 'team', teamId: eng._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    await create('manager2', { title: 'Design sync', type: 'team', teamId: design._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    await mk('manager', { title: 'Apollo kickoff', visibility: 'project', projectId: apollo._id.toString() });
    await mk('empC', { title: 'Lunch' });
    expect(await titles('empA', { scope: 'team', teamId: eng._id.toString(), types: 'team,general' })).toEqual(['Apollo kickoff', 'Eng sync']);
    expect(await titles('manager2', { scope: 'team', teamId: design._id.toString(), types: 'team,general' })).toEqual(['Design sync']);
  });

  it('visibility: team events only for that team (and team admins); org events for everyone but guests', async () => {
    await create('manager', { title: 'Eng sync', type: 'team', teamId: eng._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    await create('admin', { title: 'All hands', type: 'organization', start: '2026-03-11T09:00', end: '2026-03-11T10:00', timezone: 'UTC' }).expect(201);

    expect(await titles('empA')).toEqual(['All hands', 'Eng sync']);
    expect(await titles('empB')).toEqual(['All hands']); // not on Eng
    expect(await titles('manager2')).toEqual(['All hands']);
    expect(await titles('hr')).toEqual(['All hands', 'Eng sync']); // HR administers teams
    expect(await titles('admin')).toEqual(['All hands', 'Eng sync']);
    expect(await titles('guest')).toEqual([]); // guests see neither
    expect(await titles('empOtherOrg')).toEqual([]);
  });

  it('organization calendar defaults to org events, meetings and project deadlines', async () => {
    await create('admin', { title: 'All hands', type: 'organization', start: '2026-03-11T09:00', end: '2026-03-11T10:00', timezone: 'UTC' }).expect(201);
    await mk('empA', { title: 'Lunch' });
    await Task.create({ organization: orgA._id, project: apollo._id, title: 'A task', owner: users.manager._id, createdBy: users.manager._id, assignees: [users.empA._id], visibility: 'Public', dueDate: new Date('2026-03-12') });
    const march = (await items('admin', { scope: 'organization' })).map((i) => `${i.source}:${i.title}`).sort();
    expect(march).toEqual(['event:All hands']); // the task and the personal lunch are not org-level items
    const june = (await items('admin', { scope: 'organization', ...JUNE })).map((i) => `${i.source}:${i.title}`).sort();
    expect(june).toEqual(['project:Apollo', 'project:Gemini']);
  });

  it('personal scope: my events + everything I\'m invited to, but not other people\'s private events', async () => {
    await mk('empA', { title: 'Mine' });
    await mk('empC', { title: 'Theirs' });
    await mk('empC', { title: 'Invites A', attendees: [users.empA._id.toString()] });
    expect(await titles('empA', { types: 'general' })).toEqual(['Invites A', 'Mine']);
    expect(await titles('empC', { types: 'general' })).toEqual(['Invites A', 'Theirs']);
  });

  it('legend toggles: the `types` filter limits categories, and events can be filtered by assignee/project/search', async () => {
    await mk('empA', { title: 'Alpha review', attendees: [users.empB._id.toString()] });
    await create('manager', { title: 'Apollo kickoff', type: 'general', visibility: 'project', projectId: apollo._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    expect(await titles('empA', { types: 'personal' })).toEqual([]);
    expect(await titles('empA', { types: 'general' })).toEqual(['Alpha review', 'Apollo kickoff']);
    expect(await titles('empA', { types: 'general', q: 'alpha' })).toEqual(['Alpha review']);
    expect(await titles('empA', { types: 'general', projectId: apollo._id.toString() })).toEqual(['Apollo kickoff']);
    expect(await titles('empA', { types: 'general', assigneeId: users.empB._id.toString() })).toEqual(['Alpha review']);
    expect(await titles('empA', { types: 'general', status: 'cancelled' })).toEqual([]);
  });
});

describe('guests stay read-only and see only what they are authorised to see', () => {
  it('sees events they are invited to and events of projects they are an explicit member of — nothing else', async () => {
    const mk = (body) => create('manager', { type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', ...body }).expect(201);
    await mk({ title: 'Invited', attendees: [users.guest._id.toString()] });
    await mk({ title: 'Apollo only', visibility: 'project', projectId: apollo._id.toString() });
    await create('manager2', { title: 'Gemini only', type: 'general', visibility: 'project', projectId: gemini._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    await mk({ title: 'Private' });
    await create('admin', { title: 'All hands', type: 'organization', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);

    expect(await titles('guest', { types: 'general,organization,team,personal' })).toEqual(['Apollo only', 'Invited']);
  });

  it('cannot create, edit, delete or respond — even for events they can see', async () => {
    const event = (await create('manager', { title: 'Invited', type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', attendees: [users.guest._id.toString()] }).expect(201)).body.event;
    await as('guest').get(`/api/v1/calendar/events/${event.id}`).expect(200);
    await as('guest').patch(`/api/v1/calendar/events/${event.id}`).send({ title: 'x' }).expect(403);
    await as('guest').delete(`/api/v1/calendar/events/${event.id}`).expect(403);
    await as('guest').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }).expect(403);
    await create('guest', personal()).expect(403);
    const detail = (await as('guest').get(`/api/v1/calendar/events/${event.id}`)).body.event;
    expect(detail).toMatchObject({ canManage: false, readOnly: true });
  });
});

describe('RSVP', () => {
  it('attendees can respond; others cannot', async () => {
    const event = (await create('empA', { title: 'Lunch', type: 'general', start: '2026-03-10T12:00', end: '2026-03-10T13:00', timezone: 'UTC', attendees: [users.empB._id.toString()] }).expect(201)).body.event;
    const res = await as('empB').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }).expect(200);
    expect(res.body.event.myStatus).toBe('accepted');
    expect((await CalendarEvent.findById(event.id)).attendees[0].status).toBe('accepted');
    await as('empB').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'maybe' }).expect(400);
    await as('empC').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }).expect(404); // can't see it
    await as('empA').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }).expect(403); // the owner is not an attendee
  });
});

describe('organization isolation and blocked users', () => {
  it('another organization can never see or change events, even with ids', async () => {
    const event = (await create('admin', { title: 'All hands', type: 'organization', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201)).body.event;
    const mine = (await create('adminB', { title: 'Globex only', type: 'organization', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201)).body.event;

    for (const key of ['adminB', 'empOtherOrg']) {
      // eslint-disable-next-line no-await-in-loop
      await as(key).get(`/api/v1/calendar/events/${event.id}`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      await as(key).patch(`/api/v1/calendar/events/${event.id}`).send({ title: 'pwned' }).expect(404);
      // eslint-disable-next-line no-await-in-loop
      await as(key).delete(`/api/v1/calendar/events/${event.id}`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      await as(key).post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }).expect(404);
    }
    expect(await titles('adminB', { scope: 'organization', types: 'organization' })).toEqual(['Globex only']);
    expect(await titles('admin', { scope: 'organization', types: 'organization' })).toEqual(['All hands']);
    expect((await CalendarEvent.findById(event.id)).title).toBe('All hands');
    expect((await CalendarEvent.findById(event.id)).deletedAt).toBeNull();
    await as('admin').get(`/api/v1/calendar/events/${mine.id}`).expect(404);
  });

  it('cannot attach an event to another organization\'s team or project', async () => {
    const foreignTeam = await Team.create({ organization: orgB._id, name: 'Foreign', members: [] });
    await create('admin', { title: 'x', type: 'team', teamId: foreignTeam._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(404);
    await get('admin', { scope: 'team', teamId: foreignTeam._id.toString() }).expect(404);
  });

  it('organization-blocked users are refused on every calendar route', async () => {
    const event = (await create('empA', personal()).expect(201)).body.event;
    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    const calls = [
      () => get('empA'),
      () => as('empA').get(`/api/v1/calendar/events/${event.id}`),
      () => create('empA', personal()),
      () => as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ title: 'x' }),
      () => as('empA').delete(`/api/v1/calendar/events/${event.id}`),
      () => as('empA').post(`/api/v1/calendar/events/${event.id}/rsvp`).send({ status: 'accepted' }),
      () => as('empA').get('/api/v1/calendar/preferences'),
      () => as('empA').put('/api/v1/calendar/preferences').send({ defaultView: 'week' }),
    ];
    for (const call of calls) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORG_BLOCKED');
    }
  });

  it('a user removed from an attendee list (or the organization) loses access immediately', async () => {
    const event = (await create('empA', { title: 'Lunch', type: 'general', start: '2026-03-10T12:00', end: '2026-03-10T13:00', timezone: 'UTC', attendees: [users.empB._id.toString()] }).expect(201)).body.event;
    await as('empB').get(`/api/v1/calendar/events/${event.id}`).expect(200);
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ attendees: [] }).expect(200);
    await as('empB').get(`/api/v1/calendar/events/${event.id}`).expect(404);
    expect(await titles('empB', { types: 'general' })).toEqual([]);
  });
});

describe('calendar preferences', () => {
  it('has defaults, validates, and is per user', async () => {
    const defaults = (await as('empA').get('/api/v1/calendar/preferences').expect(200)).body.preferences;
    expect(defaults).toMatchObject({ timezone: 'Asia/Kolkata', timezoneSource: 'default', weekStartsOn: 1, defaultView: 'month', hiddenCategories: [] });

    const updated = await as('empA').put('/api/v1/calendar/preferences').send({ timezone: NY, weekStartsOn: 0, defaultView: 'agenda', hiddenCategories: ['task', 'personal'] }).expect(200);
    expect(updated.body.preferences).toMatchObject({ timezone: NY, timezoneSource: 'user', weekStartsOn: 0, defaultView: 'agenda', hiddenCategories: ['task', 'personal'] });
    expect((await as('empB').get('/api/v1/calendar/preferences').expect(200)).body.preferences.weekStartsOn).toBe(1);

    expect((await as('empA').put('/api/v1/calendar/preferences').send({ timezone: 'Nope/Zone' }).expect(400)).body.code).toBe('INVALID_TIMEZONE');
    await as('empA').put('/api/v1/calendar/preferences').send({ weekStartsOn: 3 }).expect(400);
    await as('empA').put('/api/v1/calendar/preferences').send({ defaultView: 'year' }).expect(400);
    await as('empA').put('/api/v1/calendar/preferences').send({ hiddenCategories: ['bogus'] }).expect(400);
    await as('empA').put('/api/v1/calendar/preferences').send({}).expect(400);
    await as('empA').put('/api/v1/calendar/preferences').send({ user: users.empB._id.toString(), weekStartsOn: 0 }).expect(400);

    const reset = await as('empA').put('/api/v1/calendar/preferences').send({ timezone: null }).expect(200);
    expect(reset.body.preferences.timezoneSource).toBe('default');
  });
});

describe('notifications for calendar events', () => {
  const notes = (key, type) => Notification.find({ recipient: users[key]._id, ...(type ? { type } : {}) }).lean();

  it('invites attendees (not the actor), links to the event, and honours the calendar preference', async () => {
    const event = (await create('empA', { title: 'Design review', type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', attendees: [users.empB._id.toString(), users.empC._id.toString()] }).expect(201)).body.event;
    expect(await notes('empA')).toHaveLength(0);
    const [invite] = await notes('empB', 'calendar.event_invited');
    expect(invite).toMatchObject({ category: 'calendar', title: 'Event invitation', message: 'EmpA Tester invited you to “Design review”.' });
    expect(invite.target.id.toString()).toBe(event.id);

    const inbox = (await as('empB').get('/api/v1/notifications').expect(200)).body.notifications;
    expect(inbox[0]).toMatchObject({ link: `/dashboard/calendar?event=${event.id}`, available: true });

    // Calendar notifications have their own preference row.
    await as('empC').put('/api/v1/notifications/preferences').send({ categories: { calendar: { inApp: false } } }).expect(200);
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ attendees: [users.empB._id.toString(), users.empC._id.toString(), users.empA._id.toString()] }).expect(200);
    const empCInvites = await Notification.find({ recipient: users.empC._id, type: 'calendar.event_invited', inApp: true });
    expect(empCInvites.length).toBe(1); // only the original; re-saving didn't re-invite and the new setting is respected
  });

  it('tells attendees about meaningful changes and cancellations (cancellations never link)', async () => {
    const event = (await create('empA', { title: 'Design review', type: 'general', start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC', attendees: [users.empB._id.toString()] }).expect(201)).body.event;
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ description: 'Agenda link' }).expect(200);
    expect(await notes('empB', 'calendar.event_updated')).toHaveLength(0); // a description tweak isn't worth a ping

    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ start: '2026-03-10T11:00', end: '2026-03-10T12:00' }).expect(200);
    expect(await notes('empB', 'calendar.event_updated')).toHaveLength(1);

    await as('empA').delete(`/api/v1/calendar/events/${event.id}`).expect(200);
    const inbox = (await as('empB').get('/api/v1/notifications').expect(200)).body.notifications;
    const cancelled = inbox.find((n) => n.type === 'calendar.event_cancelled');
    expect(cancelled).toMatchObject({ link: null, available: true });
    expect(cancelled.message).toBe('EmpA Tester cancelled “Design review”.');
    // The older invitation now points at a deleted event: no link, message withheld.
    expect(inbox.find((n) => n.type === 'calendar.event_invited')).toMatchObject({ link: null, available: false });
  });

  it('single-occurrence changes notify with the right wording', async () => {
    const event = (await create('empA', {
      title: 'Standup', type: 'general', start: '2026-03-02T09:00', end: '2026-03-02T09:30', timezone: 'UTC', attendees: [users.empB._id.toString()],
      recurrence: { freq: 'weekly', byWeekday: [1] },
    }).expect(201)).body.event;
    const target = (await items('empA', { tz: 'UTC' })).find((i) => i.start.startsWith('2026-03-09'));
    await as('empA').delete(`/api/v1/calendar/events/${event.id}?scope=occurrence&occurrenceStart=${target.occurrenceStart}`).expect(200);
    const [cancelled] = await notes('empB', 'calendar.event_cancelled');
    expect(cancelled.message).toBe('EmpA Tester cancelled “Standup” (one occurrence).');
  });

  it('team events notify the whole team roster, not other teams', async () => {
    await create('manager', { title: 'Eng sync', type: 'team', teamId: eng._id.toString(), start: '2026-03-10T09:00', end: '2026-03-10T10:00', timezone: 'UTC' }).expect(201);
    expect(await notes('empA', 'calendar.event_invited')).toHaveLength(1);
    expect(await notes('manager')).toHaveLength(0); // the creator
    expect(await notes('manager2')).toHaveLength(0);
    expect(await notes('empB')).toHaveLength(0);
  });

  it('writes audit entries for create, update, occurrence changes and delete', async () => {
    const event = (await create('empA', { title: 'Standup', type: 'general', start: '2026-03-02T09:00', end: '2026-03-02T09:30', timezone: 'UTC', recurrence: { freq: 'weekly', byWeekday: [1] } }).expect(201)).body.event;
    const occ = (await items('empA', { tz: 'UTC' }))[1];
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ scope: 'occurrence', occurrenceStart: String(occ.occurrenceStart), title: 'One-off' }).expect(200);
    await as('empA').patch(`/api/v1/calendar/events/${event.id}`).send({ title: 'Renamed' }).expect(200);
    await as('empA').delete(`/api/v1/calendar/events/${event.id}`).expect(200);
    const actions = (await AuditLog.find({ entityId: event.id }).lean()).map((log) => log.action).sort();
    expect(actions).toEqual(['calendar_event.created', 'calendar_event.deleted', 'calendar_event.occurrence_updated', 'calendar_event.updated']);
  });
});
