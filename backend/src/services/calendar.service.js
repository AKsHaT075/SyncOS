const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const {
  ATTENDEE_STATUS,
  DEFAULT_TIME_ZONE,
  EVENT_STATUS,
  EVENT_TYPES,
  EVENT_VISIBILITY,
  LIMITS,
  RECURRENCE_FREQ,
  TYPE_VISIBILITY,
} = require('../constants/calendar.constants');
const CalendarEvent = require('../models/CalendarEvent');
const CalendarPreference = require('../models/CalendarPreference');
const Organization = require('../models/Organization');
const Project = require('../models/Project');
const Team = require('../models/Team');
const User = require('../models/User');
const {
  attendeeEntry,
  canCreateEventOfType,
  canManageEvent,
  canViewEvent,
  idOf,
  isGuest,
  isSame,
} = require('../utils/calendarAccess');
const { isOccurrenceOf, expandRecurrence } = require('../utils/recurrence');
const {
  dateOnlyString,
  isValidTimeZone,
  localDateOf,
  localDateTimeOf,
  parseDateOnly,
  parseDateTime,
  wallToUtc,
  zonedParts,
} = require('../utils/timezone');
const { logAudit } = require('./audit.service');
const { loadCalendarContext } = require('./calendarContext');
const events = require('./notificationEvents');

const DAY_MS = 86400000;
const MIN_YEAR_MS = Date.UTC(1970, 0, 1);
const MAX_YEAR_MS = Date.UTC(2101, 0, 1);
const MAX_EVENT_DURATION_MS = 366 * DAY_MS;

const fullName = (user) => (user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '');

// ---- preferences & timezone -----------------------------------------------

/**
 * Timezone resolution: explicit request → the user's saved zone → the
 * organization default (Organization.settings.timezone) → IST (Asia/Kolkata).
 */
async function resolveTimeZone(user, requested = null) {
  if (requested && isValidTimeZone(requested)) return { timeZone: requested, source: 'request' };
  const [preference, organization] = await Promise.all([
    CalendarPreference.findOne({ user: user._id, organization: user.organization }).select('timezone').lean(),
    Organization.findById(user.organization).select('settings').lean(),
  ]);
  if (preference?.timezone && isValidTimeZone(preference.timezone)) return { timeZone: preference.timezone, source: 'user' };
  const orgZone = organization?.settings?.timezone;
  if (orgZone && isValidTimeZone(orgZone)) return { timeZone: orgZone, source: 'organization' };
  return { timeZone: DEFAULT_TIME_ZONE, source: 'default' };
}

async function getPreferences({ user }) {
  if (!user.organization) throw new AppError('You are not part of an organization', 403, 'NO_ORGANIZATION');
  const [doc, zone] = await Promise.all([
    CalendarPreference.findOne({ user: user._id, organization: user.organization }).lean(),
    resolveTimeZone(user),
  ]);
  return {
    preferences: {
      timezone: zone.timeZone,
      timezoneSource: zone.source, // 'user' | 'organization' | 'default'
      weekStartsOn: doc?.weekStartsOn ?? 1,
      defaultView: doc?.defaultView ?? 'month',
      hiddenCategories: doc?.hiddenCategories ?? [],
    },
  };
}

async function updatePreferences({ user, updates }) {
  if (!user.organization) throw new AppError('You are not part of an organization', 403, 'NO_ORGANIZATION');
  if (updates.timezone && !isValidTimeZone(updates.timezone)) {
    throw new AppError('Unknown timezone', 400, 'INVALID_TIMEZONE');
  }
  await CalendarPreference.findOneAndUpdate(
    { user: user._id, organization: user.organization },
    { $set: updates },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return getPreferences({ user });
}

// ---- parsing & validation helpers ------------------------------------------

function bad(message, code = 'VALIDATION_ERROR') {
  return new AppError(message, 400, code);
}

function checkRange(ms) {
  if (ms === null || ms < MIN_YEAR_MS || ms >= MAX_YEAR_MS) throw bad('That date is out of the supported range', 'INVALID_DATE');
}

/** Returns { start, end } (ms). All-day: `end` is the user's LAST day, stored exclusive. */
function parseTimes({ allDay, start, end, timeZone }) {
  if (allDay) {
    const startMs = parseDateOnly(start);
    const lastDayMs = parseDateOnly(end);
    if (startMs === null || lastDayMs === null) throw bad('All-day events need dates in YYYY-MM-DD format', 'INVALID_DATE');
    checkRange(startMs);
    checkRange(lastDayMs);
    if (lastDayMs < startMs) throw bad('The end date must be on or after the start date', 'INVALID_TIME_RANGE');
    return { start: startMs, end: lastDayMs + DAY_MS };
  }
  const startMs = parseDateTime(start, timeZone);
  const endMs = parseDateTime(end, timeZone);
  checkRange(startMs);
  checkRange(endMs);
  if (endMs <= startMs) throw bad('The end time must be after the start time', 'INVALID_TIME_RANGE');
  return { start: startMs, end: endMs };
}

function assertDuration(start, end) {
  if (end - start > MAX_EVENT_DURATION_MS) throw bad('Events can last at most a year', 'INVALID_TIME_RANGE');
}

function normalizeRecurrence(rule, { allDay, timeZone, start }) {
  if (!rule) return null;
  const first = zonedParts(start, allDay ? 'UTC' : timeZone);
  const stored = { freq: rule.freq, interval: rule.interval || 1 };

  if (rule.freq === RECURRENCE_FREQ.WEEKLY) {
    stored.byWeekday = [...new Set(rule.byWeekday?.length ? rule.byWeekday : [first.weekday])].sort((a, b) => a - b);
  }
  if (rule.freq === RECURRENCE_FREQ.MONTHLY) {
    stored.monthly = rule.monthly || { mode: 'date', day: first.day };
  }

  // The first date must itself satisfy the rule, otherwise the event would not
  // appear on its own start date (the UI derives rule defaults from the start).
  const probe = { start, end: start + 1, allDay, timezone: timeZone, recurrence: { ...stored } };
  if (!isOccurrenceOf(probe, start)) {
    throw bad('The first date must match the repeat rule (e.g. the start must fall on a selected weekday)', 'INVALID_RECURRENCE');
  }

  if (rule.count) {
    stored.count = rule.count;
  } else if (rule.until) {
    let until;
    if (/^\d{4}-\d{2}-\d{2}$/.test(rule.until)) {
      // "Repeat until <date>": inclusive of that whole day.
      until = allDay ? parseDateOnly(rule.until) : parseDateTime(`${rule.until}T23:59`, timeZone);
    } else {
      until = parseDateTime(rule.until, timeZone);
    }
    checkRange(until);
    if (until < start) throw bad('The recurrence must end after the event starts', 'INVALID_RECURRENCE');
    stored.until = new Date(until);
  }
  return stored;
}

function normalizeReminders(reminders = []) {
  const byMinutes = new Map();
  reminders.forEach((reminder) => byMinutes.set(reminder.minutesBefore, reminder.email === true));
  return [...byMinutes.entries()]
    .map(([minutesBefore, email]) => ({ minutesBefore, email }))
    .sort((a, b) => a.minutesBefore - b.minutesBefore);
}

async function validateAttendees(attendeeIds, organization, ownerId) {
  const unique = [...new Set((attendeeIds || []).map(String))].filter((id) => id !== String(ownerId));
  if (unique.length === 0) return [];
  if (unique.some((id) => !mongoose.isValidObjectId(id))) throw new AppError('Attendee not found', 404, 'NOT_FOUND');
  const users = await User.find({ _id: { $in: unique }, organization, isActive: true, orgBlocked: { $ne: true } })
    .select('_id')
    .lean();
  if (users.length !== unique.length) {
    throw new AppError('One or more attendees could not be found in your organization', 404, 'NOT_FOUND');
  }
  return unique;
}

async function findTeam(teamId, organization) {
  if (!mongoose.isValidObjectId(teamId)) throw new AppError('Team not found', 404, 'NOT_FOUND');
  const team = await Team.findOne({ _id: teamId, organization }).lean();
  if (!team) throw new AppError('Team not found', 404, 'NOT_FOUND');
  return team;
}

async function findProject(projectId, organization) {
  if (!mongoose.isValidObjectId(projectId)) throw new AppError('Project not found', 404, 'NOT_FOUND');
  const project = await Project.findOne({ _id: projectId, organization, deletedAt: null }).select('name organization').lean();
  if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
  return project;
}

// ---- serialisation ---------------------------------------------------------

async function loadNames(eventList) {
  const userIds = new Set();
  const teamIds = new Set();
  const projectIds = new Set();
  eventList.forEach((event) => {
    userIds.add(idOf(event.owner));
    event.attendees.forEach((a) => userIds.add(idOf(a.user)));
    if (event.team) teamIds.add(idOf(event.team));
    if (event.project) projectIds.add(idOf(event.project));
  });
  const [users, teams, projects] = await Promise.all([
    userIds.size ? User.find({ _id: { $in: [...userIds] } }).select('firstName lastName').lean() : [],
    teamIds.size ? Team.find({ _id: { $in: [...teamIds] } }).select('name').lean() : [],
    projectIds.size ? Project.find({ _id: { $in: [...projectIds] } }).select('name').lean() : [],
  ]);
  return {
    users: new Map(users.map((user) => [idOf(user._id), fullName(user)])),
    teams: new Map(teams.map((team) => [idOf(team._id), team.name])),
    projects: new Map(projects.map((project) => [idOf(project._id), project.name])),
  };
}

/** Fields shared by the detail endpoint and calendar items. Times are added by the caller. */
function eventPayload(event, { ctx, names }) {
  const mine = attendeeEntry(event, ctx.user._id);
  const manage = canManageEvent(ctx, event);
  return {
    eventId: idOf(event._id),
    type: event.type,
    category: event.type,
    visibility: event.visibility,
    title: event.title,
    description: event.description,
    location: event.location,
    meetingUrl: event.meetingUrl,
    allDay: event.allDay,
    timezone: event.timezone,
    recurring: Boolean(event.recurrence),
    owner: { id: idOf(event.owner), name: names.users.get(idOf(event.owner)) || '' },
    team: event.team ? { id: idOf(event.team), name: names.teams.get(idOf(event.team)) || '' } : null,
    project: event.project ? { id: idOf(event.project), name: names.projects.get(idOf(event.project)) || '' } : null,
    attendees: event.attendees.map((a) => ({ id: idOf(a.user), name: names.users.get(idOf(a.user)) || '', status: a.status })),
    myStatus: mine ? mine.status : null,
    isOwner: isSame(event.owner, ctx.user._id),
    canManage: manage,
    readOnly: !manage,
  };
}

function timedFields(event, startMs, endMs) {
  if (event.allDay) {
    return { start: null, end: null, startDate: dateOnlyString(startMs), endDate: dateOnlyString(endMs - DAY_MS) };
  }
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startDate: null, endDate: null };
}

async function serializeDetail(event, ctx) {
  const names = await loadNames([event]);
  const payload = eventPayload(event, { ctx, names });
  const startMs = event.start.getTime();
  const endMs = event.end.getTime();
  return {
    id: payload.eventId,
    ...payload,
    ...timedFields(event, startMs, endMs),
    // Wall-clock values in the event's own zone — exactly what an edit form should show.
    startLocal: event.allDay ? dateOnlyString(startMs) : localDateTimeOf(startMs, event.timezone),
    endLocal: event.allDay ? dateOnlyString(endMs - DAY_MS) : localDateTimeOf(endMs, event.timezone),
    recurrence: event.recurrence
      ? {
          freq: event.recurrence.freq,
          interval: event.recurrence.interval,
          byWeekday: event.recurrence.byWeekday,
          monthly: event.recurrence.monthly?.mode ? event.recurrence.monthly : undefined,
          until: event.recurrence.until ? new Date(event.recurrence.until).toISOString() : null,
          untilLocal: event.recurrence.until
            ? (event.allDay ? dateOnlyString(event.recurrence.until.getTime()) : localDateOf(event.recurrence.until.getTime(), event.timezone))
            : null,
          count: event.recurrence.count ?? null,
        }
      : null,
    exceptionCount: event.exceptions.length,
    reminders: payload.canManage ? event.reminders.map((r) => ({ minutesBefore: r.minutesBefore, email: r.email })) : [],
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

// ---- audience ---------------------------------------------------------------

/** Who is told about an event: owner + attendees (+ the team roster for team events). */
async function eventAudience(event, { includeDeclined = false } = {}) {
  const ids = new Set([idOf(event.owner)]);
  event.attendees.forEach((a) => {
    if (includeDeclined || a.status !== ATTENDEE_STATUS.DECLINED) ids.add(idOf(a.user));
  });
  if (event.type === EVENT_TYPES.TEAM && event.team) {
    const team = await Team.findOne({ _id: event.team, organization: event.organization }).select('members lead').lean();
    (team?.members || []).forEach((member) => ids.add(idOf(member)));
    if (team?.lead) ids.add(idOf(team.lead));
  }
  return [...ids];
}

// ---- lookups ----------------------------------------------------------------

async function loadEvent(id, actor, { ctx = null } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Event not found', 404, 'NOT_FOUND');
  const event = await CalendarEvent.findOne({ _id: id, organization: actor.organization, deletedAt: null });
  if (!event) throw new AppError('Event not found', 404, 'NOT_FOUND');
  const context = ctx || (await loadCalendarContext(actor)).ctx;
  // Events the actor can't see are reported as missing, not forbidden.
  if (!canViewEvent(context, event)) throw new AppError('Event not found', 404, 'NOT_FOUND');
  return { event, ctx: context };
}

async function loadManageableEvent(id, actor) {
  const loaded = await loadEvent(id, actor);
  if (!canManageEvent(loaded.ctx, loaded.event)) {
    throw new AppError('You do not have permission to modify this event', 403, 'FORBIDDEN');
  }
  return loaded;
}

function parseOccurrenceStart(value) {
  if (!value) throw bad('occurrenceStart is required to change a single occurrence', 'OCCURRENCE_REQUIRED');
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isNaN(ms)) throw bad('Invalid occurrenceStart', 'INVALID_OCCURRENCE');
  return ms;
}

function assertGenuineOccurrence(event, originalStart) {
  if (!event.recurrence) throw bad('This event does not repeat', 'NOT_RECURRING');
  const shape = {
    start: event.start.getTime(), end: event.end.getTime(), allDay: event.allDay,
    timezone: event.timezone, recurrence: event.recurrence.toObject ? event.recurrence.toObject() : event.recurrence,
  };
  // Prevents forged exceptions for dates the series never produces.
  if (!isOccurrenceOf(shape, originalStart)) throw bad('That date is not an occurrence of this event', 'INVALID_OCCURRENCE');
}

const audit = (actor, req, action, event, metadata = {}) =>
  logAudit({
    action,
    entityId: event._id.toString(),
    entityType: 'calendar_event',
    metadata: { title: event.title, type: event.type, ...metadata },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

// ---- create -----------------------------------------------------------------

async function createEvent({ actor, body, req }) {
  const { ctx } = await loadCalendarContext(actor);

  const allowed = TYPE_VISIBILITY[body.type];
  const visibility = body.visibility || allowed[0];
  if (!allowed.includes(visibility)) {
    throw bad(`A ${body.type} event cannot use "${visibility}" visibility`, 'INVALID_VISIBILITY');
  }

  let team = null;
  let project = null;
  if (body.type === EVENT_TYPES.TEAM) {
    if (!body.teamId) throw bad('A team event needs a team', 'TEAM_REQUIRED');
    team = await findTeam(body.teamId, actor.organization);
  } else if (body.teamId) {
    throw bad('Only team events can be linked to a team', 'INVALID_TEAM');
  }
  if (visibility === EVENT_VISIBILITY.PROJECT && !body.projectId) throw bad('A project event needs a project', 'PROJECT_REQUIRED');
  if (body.projectId) {
    if (body.type !== EVENT_TYPES.GENERAL) throw bad('Only general events can be linked to a project', 'INVALID_PROJECT');
    project = await findProject(body.projectId, actor.organization);
  }

  // Team events: org admins / HR for any team, a manager only for a team they LEAD.
  if (!canCreateEventOfType(ctx, { type: body.type, team: team?._id, project: project?._id })) {
    throw new AppError('You do not have permission to create this kind of event', 403, 'FORBIDDEN');
  }

  const timeZone = body.timezone ? body.timezone : (await resolveTimeZone(actor)).timeZone;
  if (!isValidTimeZone(timeZone)) throw bad('Unknown timezone', 'INVALID_TIMEZONE');

  const allDay = body.allDay === true;
  const times = parseTimes({ allDay, start: body.start, end: body.end, timeZone });
  assertDuration(times.start, times.end);
  const recurrence = normalizeRecurrence(body.recurrence, { allDay, timeZone, start: times.start });
  const attendeeIds = await validateAttendees(body.attendees, actor.organization, actor._id);

  const event = await CalendarEvent.create({
    organization: actor.organization,
    title: body.title,
    description: body.description || '',
    location: body.location || '',
    meetingUrl: body.meetingUrl || '',
    type: body.type,
    visibility,
    team: team?._id || null,
    project: project?._id || null,
    owner: actor._id,
    attendees: attendeeIds.map((user) => ({ user, status: ATTENDEE_STATUS.INVITED })),
    allDay,
    start: new Date(times.start),
    end: new Date(times.end),
    timezone: timeZone,
    recurrence,
    reminders: normalizeReminders(body.reminders),
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  await audit(actor, req, AUDIT_EVENTS.CALENDAR_EVENT_CREATED, event, { recurring: Boolean(recurrence), attendees: attendeeIds.length });

  const audience = event.type === EVENT_TYPES.TEAM ? await eventAudience(event) : attendeeIds;
  await events.calendarInvited({ event, actor, userIds: audience, occurrence: `created:${event.createdAt.getTime()}` });

  return { event: await serializeDetail(event, ctx) };
}

async function getEvent({ actor, id }) {
  const { event, ctx } = await loadEvent(id, actor);
  return { event: await serializeDetail(event, ctx) };
}

// ---- update -----------------------------------------------------------------

const OCCURRENCE_FIELDS = ['title', 'description', 'location', 'meetingUrl', 'start', 'end'];

async function updateOccurrence({ actor, event, ctx, fields, occurrenceStart, req }) {
  const originalStart = parseOccurrenceStart(occurrenceStart);
  assertGenuineOccurrence(event, originalStart);

  const forbidden = Object.keys(fields).filter((key) => !OCCURRENCE_FIELDS.includes(key));
  if (forbidden.length) {
    throw bad(`These fields can only be changed for the whole series: ${forbidden.join(', ')}`, 'OCCURRENCE_FIELD_NOT_ALLOWED');
  }

  const existing = event.exceptions.find((entry) => entry.originalStart.getTime() === originalStart);
  if (!existing && event.exceptions.length >= LIMITS.MAX_EXCEPTIONS) {
    throw new AppError('This series has too many modified occurrences', 409, 'TOO_MANY_EXCEPTIONS');
  }

  const override = { originalStart: new Date(originalStart), cancelled: false };
  ['title', 'description', 'location', 'meetingUrl'].forEach((key) => {
    if (fields[key] !== undefined) override[key] = fields[key];
  });

  if (fields.start !== undefined || fields.end !== undefined) {
    const baseDuration = event.end.getTime() - event.start.getTime();
    const current = existing?.start ? { start: existing.start.getTime(), end: existing.end.getTime() } : { start: originalStart, end: originalStart + baseDuration };
    const asInput = (ms, isEnd) => (event.allDay ? dateOnlyString(isEnd ? ms - DAY_MS : ms) : localDateTimeOf(ms, event.timezone));
    const times = parseTimes({
      allDay: event.allDay,
      start: fields.start ?? asInput(current.start, false),
      end: fields.end ?? (fields.start !== undefined && !event.allDay
        ? localDateTimeOf(parseDateTime(fields.start, event.timezone) + (current.end - current.start), event.timezone)
        : asInput(current.end, true)),
      timeZone: event.timezone,
    });
    assertDuration(times.start, times.end);
    override.start = new Date(times.start);
    override.end = new Date(times.end);
  }

  const merged = existing ? { ...existing.toObject(), ...override } : override;
  event.exceptions = [...event.exceptions.filter((entry) => entry.originalStart.getTime() !== originalStart), merged];
  event.updatedBy = actor._id;
  await event.save();

  await audit(actor, req, AUDIT_EVENTS.CALENDAR_OCCURRENCE_UPDATED, event, { occurrence: originalStart });
  const audience = await eventAudience(event);
  await events.calendarUpdated({ event, actor, userIds: audience, occurrence: `occ:${originalStart}:${event.updatedAt.getTime()}` });

  return { event: await serializeDetail(event, ctx) };
}

async function updateEvent({ actor, id, body, req }) {
  const { event, ctx } = await loadManageableEvent(id, actor);
  const { scope = 'series', occurrenceStart, ...fields } = body;

  if (scope === 'occurrence') {
    if (!event.recurrence) throw bad('This event does not repeat', 'NOT_RECURRING');
    return updateOccurrence({ actor, event, ctx, fields, occurrenceStart, req });
  }

  const before = {
    start: event.start.getTime(), end: event.end.getTime(), allDay: event.allDay, timezone: event.timezone,
    recurrence: JSON.stringify(event.recurrence?.toObject?.() ?? null),
  };

  const timeZone = fields.timezone ?? event.timezone;
  if (!isValidTimeZone(timeZone)) throw bad('Unknown timezone', 'INVALID_TIMEZONE');
  const allDay = fields.allDay ?? event.allDay;

  const switchingKind = allDay !== event.allDay;
  const touchesTime = fields.start !== undefined || fields.end !== undefined;
  if (switchingKind && !(fields.start !== undefined && fields.end !== undefined)) {
    throw bad('Provide both start and end when switching between all-day and timed', 'INVALID_TIME_RANGE');
  }
  if (touchesTime || switchingKind || fields.timezone !== undefined) {
    const duration = event.end.getTime() - event.start.getTime();
    const input = {
      start: fields.start ?? (event.allDay ? dateOnlyString(event.start.getTime()) : localDateTimeOf(event.start.getTime(), event.timezone)),
      end: fields.end,
    };
    if (input.end === undefined) {
      // Only the start moved: keep the original length.
      input.end = allDay
        ? dateOnlyString(parseDateOnly(input.start) + duration - DAY_MS)
        : localDateTimeOf(parseDateTime(input.start, timeZone) + duration, timeZone);
    }
    const times = parseTimes({ allDay, ...input, timeZone });
    assertDuration(times.start, times.end);
    event.start = new Date(times.start);
    event.end = new Date(times.end);
  }
  event.allDay = allDay;
  event.timezone = timeZone;

  ['title', 'description', 'location', 'meetingUrl'].forEach((key) => {
    if (fields[key] !== undefined) event[key] = fields[key];
  });

  if (fields.recurrence !== undefined) {
    event.recurrence = normalizeRecurrence(fields.recurrence, { allDay, timeZone, start: event.start.getTime() });
  } else if (event.recurrence && (touchesTime || switchingKind)) {
    // Moving the series start re-derives implicit rule parts (weekday / day-of-month) only if the user changed them.
    event.recurrence = normalizeRecurrence(event.recurrence.toObject(), { allDay, timeZone, start: event.start.getTime() });
  }

  if (fields.reminders !== undefined) event.reminders = normalizeReminders(fields.reminders);

  let newlyInvited = [];
  if (fields.attendees !== undefined) {
    const next = await validateAttendees(fields.attendees, actor.organization, event.owner);
    const current = new Map(event.attendees.map((a) => [idOf(a.user), a.status]));
    newlyInvited = next.filter((userId) => !current.has(userId));
    event.attendees = next.map((user) => ({ user, status: current.get(user) || ATTENDEE_STATUS.INVITED }));
  }

  // A change to the series' timing/shape invalidates single-occurrence edits tied to the old schedule.
  const scheduleChanged =
    before.start !== event.start.getTime() || before.end !== event.end.getTime() || before.allDay !== event.allDay ||
    before.timezone !== event.timezone || before.recurrence !== JSON.stringify(event.recurrence?.toObject?.() ?? null);
  if (scheduleChanged && event.exceptions.length) event.exceptions = [];

  event.updatedBy = actor._id;
  await event.save();

  await audit(actor, req, AUDIT_EVENTS.CALENDAR_EVENT_UPDATED, event, { fields: Object.keys(fields), scheduleChanged });

  if (newlyInvited.length) {
    await events.calendarInvited({ event, actor, userIds: newlyInvited, occurrence: `invited:${event.updatedAt.getTime()}` });
  }
  if (scheduleChanged || ['title', 'location', 'meetingUrl'].some((key) => fields[key] !== undefined)) {
    const audience = (await eventAudience(event)).filter((userId) => !newlyInvited.includes(userId));
    await events.calendarUpdated({ event, actor, userIds: audience });
  }

  return { event: await serializeDetail(event, ctx) };
}

// ---- delete -----------------------------------------------------------------

async function deleteEvent({ actor, id, scope = 'series', occurrenceStart, req }) {
  const { event } = await loadManageableEvent(id, actor);

  if (scope === 'occurrence') {
    if (!event.recurrence) throw bad('This event does not repeat', 'NOT_RECURRING');
    const originalStart = parseOccurrenceStart(occurrenceStart);
    assertGenuineOccurrence(event, originalStart);
    const existing = event.exceptions.some((entry) => entry.originalStart.getTime() === originalStart);
    if (!existing && event.exceptions.length >= LIMITS.MAX_EXCEPTIONS) {
      throw new AppError('This series has too many modified occurrences', 409, 'TOO_MANY_EXCEPTIONS');
    }
    event.exceptions = [
      ...event.exceptions.filter((entry) => entry.originalStart.getTime() !== originalStart),
      { originalStart: new Date(originalStart), cancelled: true },
    ];
    event.updatedBy = actor._id;
    await event.save();

    await audit(actor, req, AUDIT_EVENTS.CALENDAR_OCCURRENCE_CANCELLED, event, { occurrence: originalStart });
    await events.calendarCancelled({
      event, actor, userIds: await eventAudience(event), occurrence: `occ-cancelled:${originalStart}`, occurrenceOnly: true,
    });
    return { success: true, scope: 'occurrence' };
  }

  event.deletedAt = new Date();
  event.status = EVENT_STATUS.CANCELLED;
  event.updatedBy = actor._id;
  await event.save();

  await audit(actor, req, AUDIT_EVENTS.CALENDAR_EVENT_DELETED, event, { recurring: Boolean(event.recurrence) });
  await events.calendarCancelled({ event, actor, userIds: await eventAudience(event) });
  return { success: true, scope: 'series' };
}

// ---- RSVP -------------------------------------------------------------------

async function rsvp({ actor, id, status, req }) {
  // Guests are read-only everywhere, including responding to invitations.
  if (isGuest(actor)) throw new AppError('Guests cannot respond to invitations', 403, 'FORBIDDEN');
  const { event, ctx } = await loadEvent(id, actor);
  const entry = event.attendees.find((a) => isSame(a.user, actor._id));
  if (!entry) throw new AppError('You are not invited to this event', 403, 'FORBIDDEN');

  entry.status = status;
  await event.save();
  await audit(actor, req, AUDIT_EVENTS.CALENDAR_EVENT_RSVP, event, { status });
  return { event: await serializeDetail(event, ctx) };
}

module.exports = {
  assertGenuineOccurrence,
  createEvent,
  deleteEvent,
  eventAudience,
  eventPayload,
  expandRecurrence,
  getEvent,
  getPreferences,
  loadNames,
  resolveTimeZone,
  rsvp,
  timedFields,
  updateEvent,
  updatePreferences,
  wallToUtc,
};
