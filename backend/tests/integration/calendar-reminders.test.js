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
const CalendarEvent = require('../../src/models/CalendarEvent');
const Meeting = require('../../src/models/Meeting');
const Notification = require('../../src/models/Notification');
const NotificationPreference = require('../../src/models/NotificationPreference');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const { humanLead, runCalendarReminders } = require('../../src/services/calendarReminders');
const { runMeetingReminders } = require('../../src/services/notificationJobs');
const { wallToUtc } = require('../../src/utils/timezone');

const { users, createUser, makeAgent, as } = createHarness();

const MIN = 60000;
const oid = () => new mongoose.Types.ObjectId();
let orgA;
let team;

const reminderNotes = (key) => Notification.find({ recipient: users[key]._id, type: 'calendar.reminder' }).lean();
const emailJobs = async () => (await createRedisClient().lRange('test:email:queue', 0, -1)).map((raw) => JSON.parse(raw));

// Events are created directly so each test controls the clock precisely.
function makeEvent(overrides = {}) {
  const start = overrides.start || new Date(Date.UTC(2026, 5, 1, 12, 0));
  return CalendarEvent.create({
    organization: orgA._id, title: 'Design review', type: 'general', visibility: 'participants', owner: users.owner._id,
    attendees: [{ user: users.empA._id, status: 'accepted' }, { user: users.empB._id, status: 'invited' }],
    allDay: false, start, end: new Date(start.getTime() + 30 * MIN), timezone: 'UTC',
    reminders: [{ minutesBefore: 15, email: false }], createdBy: users.owner._id,
    ...overrides,
  });
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await Promise.all([Notification.init(), CalendarEvent.init()]);
  await Promise.all(['owner', 'empA', 'empB', 'empC', 'manager', 'adminB'].map(makeAgent));
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
  await createUser(orgA, 'owner', ROLES.EMPLOYEE);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'empC', ROLES.EMPLOYEE);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  team = await Team.create({ organization: orgA._id, name: 'Eng', lead: users.manager._id, members: [users.manager._id, users.empC._id] });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

describe('scheduling', () => {
  it('reminds the owner and attendees once the reminder time arrives — not before', async () => {
    const event = await makeEvent(); // starts 12:00, reminder at 11:45
    const start = event.start.getTime();

    await runCalendarReminders({ now: start - 2 * 60 * MIN });
    await runCalendarReminders({ now: start - 16 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);

    await runCalendarReminders({ now: start - 15 * MIN });
    for (const key of ['owner', 'empA', 'empB']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await reminderNotes(key)).toHaveLength(1);
    }
    expect(await reminderNotes('empC')).toHaveLength(0); // not involved
    const [note] = await reminderNotes('empA');
    expect(note).toMatchObject({ category: 'calendar', title: 'Event starting soon', inApp: true });
    expect(note.message).toBe('“Design review” starts in about 15 minutes.');
    expect(note.target.id.toString()).toBe(event._id.toString());
  });

  it('supports several reminders, including custom offsets, each firing at its own time', async () => {
    const event = await makeEvent({ reminders: [{ minutesBefore: 5 }, { minutesBefore: 15 }, { minutesBefore: 1440 }, { minutesBefore: 90 }] });
    const start = event.start.getTime();
    for (const offset of [1440, 90, 15, 5]) {
      // eslint-disable-next-line no-await-in-loop
      await runCalendarReminders({ now: start - offset * MIN });
    }
    const notes = await reminderNotes('empA');
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.message).sort()).toEqual([
      '“Design review” starts in about 1 day.',
      '“Design review” starts in about 15 minutes.',
      '“Design review” starts in about 2 hours.', // 90 minutes, rounded
      '“Design review” starts in about 5 minutes.',
    ]);
  });

  it('describes lead times naturally', () => {
    expect(humanLead(5 * MIN)).toBe('5 minutes');
    expect(humanLead(MIN)).toBe('1 minute');
    expect(humanLead(60 * MIN)).toBe('1 hour');
    expect(humanLead(3 * 60 * MIN)).toBe('3 hours');
    expect(humanLead(24 * 60 * MIN)).toBe('1 day');
    expect(humanLead(2 * 24 * 60 * MIN)).toBe('2 days');
  });

  it('does not send reminders for events that already started or reminders far in the past (late-creation guard)', async () => {
    const event = await makeEvent({ reminders: [{ minutesBefore: 1440 }] });
    const start = event.start.getTime();
    // The event was "created" 5 minutes before it starts: its 1-day reminder time passed long ago → no stale alert.
    await runCalendarReminders({ now: start - 5 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    // Already started.
    await runCalendarReminders({ now: start + MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
  });

  it('catches up on a reminder that is a few minutes late (job restart), but not a stale one', async () => {
    const event = await makeEvent();
    const start = event.start.getTime();
    await runCalendarReminders({ now: start - 15 * MIN + 10 * MIN }); // 10 minutes late, 5 minutes before start
    expect(await reminderNotes('empA')).toHaveLength(1);
    await Notification.deleteMany({});
    await runCalendarReminders({ now: start - 15 * MIN + 20 * MIN }); // 20 minutes late: beyond the grace period
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
  });
});

describe('duplicate prevention', () => {
  it('repeated ticks (or several app instances) send each reminder once', async () => {
    const event = await makeEvent();
    const now = event.start.getTime() - 15 * MIN;
    await runCalendarReminders({ now });
    await runCalendarReminders({ now });
    await runCalendarReminders({ now: now + MIN });
    await Promise.all([runCalendarReminders({ now: now + 2 * MIN }), runCalendarReminders({ now: now + 2 * MIN })]);
    expect(await Notification.countDocuments({ recipient: users.empA._id, type: 'calendar.reminder' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(3); // owner + two attendees
  });

  it('a recurring series reminds once PER occurrence', async () => {
    const start = new Date(Date.UTC(2026, 5, 1, 9, 0)); // a Monday
    const event = await makeEvent({ start, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } });
    for (const week of [0, 1, 2]) {
      const now = start.getTime() + week * 7 * 24 * 60 * MIN - 15 * MIN;
      // eslint-disable-next-line no-await-in-loop
      await runCalendarReminders({ now });
      // eslint-disable-next-line no-await-in-loop
      await runCalendarReminders({ now: now + MIN });
    }
    expect(await Notification.countDocuments({ recipient: users.empA._id, type: 'calendar.reminder' })).toBe(3);
    expect(event.recurrence.freq).toBe('weekly');
  });

  it('recurring reminders follow the wall clock across a DST change', async () => {
    const tz = 'America/New_York';
    const start = new Date(wallToUtc({ year: 2026, month: 3, day: 2, hour: 9, minute: 0 }, tz)); // Mon, EST
    await makeEvent({ start, timezone: tz, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } });
    const after = wallToUtc({ year: 2026, month: 3, day: 9, hour: 9, minute: 0 }, tz); // Mon after spring-forward: 13:00Z, not 14:00Z
    await runCalendarReminders({ now: after - 15 * MIN });
    const [note] = await reminderNotes('empA');
    expect(note.dedupeKey).toContain(`:${after}:15`);
  });
});

describe('updates, cancellations and deletions', () => {
  it('never reminds for a deleted or cancelled event', async () => {
    const event = await makeEvent();
    await CalendarEvent.updateOne({ _id: event._id }, { deletedAt: new Date(), status: 'cancelled' });
    await runCalendarReminders({ now: event.start.getTime() - 15 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
  });

  it('skips a cancelled occurrence but still reminds for the others', async () => {
    const start = new Date(Date.UTC(2026, 5, 1, 9, 0));
    const second = new Date(Date.UTC(2026, 5, 8, 9, 0));
    await makeEvent({ start, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] }, exceptions: [{ originalStart: second, cancelled: true }] });
    await runCalendarReminders({ now: second.getTime() - 15 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    await runCalendarReminders({ now: start.getTime() + 14 * 24 * 60 * MIN - 15 * MIN }); // third Monday
    expect(await reminderNotes('empA')).toHaveLength(1);
  });

  it('uses the NEW time for a moved occurrence and sends nothing for the old slot', async () => {
    const start = new Date(Date.UTC(2026, 5, 1, 9, 0));
    const original = new Date(Date.UTC(2026, 5, 8, 9, 0));
    const movedTo = new Date(Date.UTC(2026, 5, 8, 15, 0));
    await makeEvent({
      start, recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
      exceptions: [{ originalStart: original, start: movedTo, end: new Date(movedTo.getTime() + 30 * MIN) }],
    });
    await runCalendarReminders({ now: original.getTime() - 15 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    await runCalendarReminders({ now: movedTo.getTime() - 15 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(1);
  });

  it('a rescheduled event reminds again for its new time, and the old time no longer fires', async () => {
    const event = await makeEvent();
    const oldStart = event.start.getTime();
    await runCalendarReminders({ now: oldStart - 15 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(1);

    const newStart = new Date(oldStart + 3 * 24 * 60 * MIN);
    await CalendarEvent.updateOne({ _id: event._id }, { start: newStart, end: new Date(newStart.getTime() + 30 * MIN) });
    await runCalendarReminders({ now: oldStart - 15 * MIN + MIN }); // the old slot: nothing new
    expect(await reminderNotes('empA')).toHaveLength(1);
    await runCalendarReminders({ now: newStart.getTime() - 15 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(2);
  });

  it('works end-to-end through the API: edit the time, then delete', async () => {
    const created = (await as('owner').post('/api/v1/calendar/events').send({
      title: 'Planning', type: 'general', start: '2026-06-01T12:00', end: '2026-06-01T13:00', timezone: 'UTC',
      attendees: [users.empA._id.toString()], reminders: [{ minutesBefore: 30 }],
    }).expect(201)).body.event;
    await as('owner').patch(`/api/v1/calendar/events/${created.id}`).send({ start: '2026-06-02T12:00', end: '2026-06-02T13:00' }).expect(200);

    await runCalendarReminders({ now: Date.UTC(2026, 5, 1, 11, 30) }); // the OLD reminder time
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    await runCalendarReminders({ now: Date.UTC(2026, 5, 2, 11, 30) });
    expect(await reminderNotes('empA')).toHaveLength(1);

    await as('owner').delete(`/api/v1/calendar/events/${created.id}`).expect(200);
    await Notification.deleteMany({ type: 'calendar.reminder' });
    await runCalendarReminders({ now: Date.UTC(2026, 5, 2, 11, 30) });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
  });
});

describe('who is reminded', () => {
  it('skips attendees who declined and people who were blocked', async () => {
    const event = await makeEvent({ attendees: [{ user: users.empA._id, status: 'declined' }, { user: users.empB._id, status: 'accepted' }] });
    await User.updateOne({ _id: users.owner._id }, { orgBlocked: true });
    await runCalendarReminders({ now: event.start.getTime() - 15 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(0);
    expect(await reminderNotes('owner')).toHaveLength(0);
    expect(await reminderNotes('empB')).toHaveLength(1);
  });

  it('team events remind the whole team roster', async () => {
    const event = await makeEvent({ type: 'team', visibility: 'team', team: team._id, owner: users.manager._id, attendees: [] });
    await runCalendarReminders({ now: event.start.getTime() - 15 * MIN });
    expect(await reminderNotes('manager')).toHaveLength(1);
    expect(await reminderNotes('empC')).toHaveLength(1);
    expect(await reminderNotes('empA')).toHaveLength(0);
  });

  it('respects the user\'s calendar notification preference', async () => {
    await NotificationPreference.create({ user: users.empA._id, organization: orgA._id, categories: { calendar: { inApp: false } } });
    const event = await makeEvent();
    await runCalendarReminders({ now: event.start.getTime() - 15 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(0);
    expect(await reminderNotes('empB')).toHaveLength(1);
  });
});

describe('email reminders are opt-in', () => {
  it('sends email only for reminders marked email, and only to people who allow calendar email', async () => {
    const event = await makeEvent({ reminders: [{ minutesBefore: 15, email: true }, { minutesBefore: 5, email: false }] });
    await NotificationPreference.create({ user: users.empB._id, organization: orgA._id, categories: { calendar: { email: false } } });
    const start = event.start.getTime();

    await runCalendarReminders({ now: start - 15 * MIN });
    let jobs = await emailJobs();
    expect(jobs.map((job) => job.to).sort()).toEqual([users.empA.email, users.owner.email].sort()); // empB opted out
    expect(jobs[0].subject).toContain('starts in about 15 minutes');

    await runCalendarReminders({ now: start - 5 * MIN });
    jobs = await emailJobs();
    expect(jobs).toHaveLength(2); // the 5-minute reminder is in-app only
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(6);
    expect((await Notification.findOne({ recipient: users.empB._id, type: 'calendar.reminder', 'email.status': 'none' }))).toBeTruthy();
  });

  it('a repeated tick does not send the email twice', async () => {
    const event = await makeEvent({ reminders: [{ minutesBefore: 15, email: true }] });
    const now = event.start.getTime() - 15 * MIN;
    await runCalendarReminders({ now });
    await runCalendarReminders({ now });
    expect(await emailJobs()).toHaveLength(3);
  });

  it('by default (no email flag) nothing is emailed', async () => {
    const event = await makeEvent();
    await runCalendarReminders({ now: event.start.getTime() - 15 * MIN });
    expect(await emailJobs()).toHaveLength(0);
  });
});

describe('all-day events', () => {
  it('measure reminders from local midnight in the event\'s timezone', async () => {
    const tz = 'Asia/Tokyo';
    const day = Date.UTC(2026, 5, 10); // the date 2026-06-10, stored floating
    await makeEvent({
      allDay: true, start: new Date(day), end: new Date(day + 86400000), timezone: tz,
      reminders: [{ minutesBefore: 1440 }],
    });
    const midnightTokyo = wallToUtc({ year: 2026, month: 6, day: 10, hour: 0, minute: 0 }, tz); // 2026-06-09T15:00Z
    await runCalendarReminders({ now: midnightTokyo - 1440 * MIN - 5 * MIN });
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    await runCalendarReminders({ now: midnightTokyo - 1440 * MIN });
    expect(await reminderNotes('empA')).toHaveLength(1);
  });
});

describe('meeting reminders are untouched', () => {
  it('meetings keep their own 15-minute in-app reminder and never get a calendar reminder', async () => {
    const project = await Project.create({
      organization: orgA._id, owner: users.manager._id, createdBy: users.manager._id, name: 'Apollo', slug: 'apollo',
      members: [{ user: users.manager._id, role: 'Owner' }, { user: users.empA._id, role: 'Contributor' }],
    });
    await Meeting.create({
      organization: orgA._id, project: project._id, topic: 'Standup', type: 'Scheduled', status: 'Scheduled',
      startTime: new Date(Date.now() + 10 * MIN), endTime: new Date(Date.now() + 40 * MIN),
      host: users.manager._id, createdBy: users.manager._id,
      participants: [{ user: users.manager._id, role: 'Host', status: 'Accepted' }, { user: users.empA._id, role: 'Participant', status: 'Invited' }],
    });

    await runMeetingReminders();
    await runCalendarReminders({ now: Date.now() });
    expect(await Notification.countDocuments({ recipient: users.empA._id, type: 'meeting.reminder' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'calendar.reminder' })).toBe(0);
    expect(await CalendarEvent.countDocuments()).toBe(0); // no calendar copy of the meeting exists to remind about
  });
});
