const AppError = require('../utils/app-error');
const {
  CALENDAR_SCOPES,
  DEFAULT_MEETING_DURATION_MS,
  EVENT_STATUS,
  EVENT_TYPES,
  ITEM_SOURCES,
  LIMITS,
} = require('../constants/calendar.constants');
const { MEETING_STATUS } = require('../constants/meeting.constants');
const CalendarEvent = require('../models/CalendarEvent');
const Meeting = require('../models/Meeting');
const Project = require('../models/Project');
const Task = require('../models/Task');
const Team = require('../models/Team');
const {
  buildEventVisibilityFilter,
  canViewEvent,
  idOf,
  isOrgAdmin,
  isTeamAdmin,
} = require('../utils/calendarAccess');
const { canJoinMeeting, canViewMeeting } = require('../utils/meetingAccess');
const { expandRecurrence } = require('../utils/recurrence');
const { addDaysToDateString, dateOnlyString, parseDateOnly, wallToUtc } = require('../utils/timezone');
const { canViewTask } = require('../utils/taskAccess');
const { eventPayload, loadNames, resolveTimeZone, timedFields } = require('./calendar.service');
const { loadCalendarContext } = require('./calendarContext');

const DAY_MS = 86400000;
const JOIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LISTED_PARTICIPANTS = 12;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fullName = (user) => (user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '');

// Defaults per scope when the client doesn't say which categories it wants.
const DEFAULT_CATEGORIES = {
  [CALENDAR_SCOPES.PERSONAL]: [...Object.values(EVENT_TYPES), 'meeting', 'task', 'project'],
  [CALENDAR_SCOPES.TEAM]: [...Object.values(EVENT_TYPES), 'meeting', 'task', 'project'],
  [CALENDAR_SCOPES.ORGANIZATION]: [EVENT_TYPES.ORGANIZATION, 'meeting', 'project'],
};

/**
 * Unified calendar read model. NOTHING is copied: meetings, tasks and project
 * deadlines are read from their own collections at request time, each under
 * that module's own access rules; calendar events come from CalendarEvent.
 * Every item carries `source`, a stable `id`, and a `link` to its own page.
 *
 * Dates:
 *   timed items      -> `start` / `end` ISO instants (UTC)
 *   all-day items    -> `startDate` / `endDate` 'YYYY-MM-DD' (inclusive, FLOATING:
 *                       tasks' and projects' due dates are date-only values and are
 *                       never shifted by a timezone)
 */
async function getCalendar({ actor, query }) {
  const { timeZone, source: timeZoneSource } = await resolveTimeZone(actor, query.tz);

  const fromDateMs = parseDateOnly(query.fromDate);
  const toDateMs = parseDateOnly(query.toDate);
  if (fromDateMs === null || toDateMs === null || toDateMs < fromDateMs) {
    throw new AppError('Invalid date range', 400, 'INVALID_RANGE');
  }
  if ((toDateMs - fromDateMs) / DAY_MS + 1 > LIMITS.MAX_RANGE_DAYS) {
    throw new AppError(`The date range cannot exceed ${LIMITS.MAX_RANGE_DAYS} days`, 400, 'RANGE_TOO_LARGE');
  }

  // The visible days as UTC instants in the viewer's zone (DST-safe: converted per boundary).
  const rangeStart = wallToUtc({ ...splitDate(query.fromDate), hour: 0, minute: 0 }, timeZone);
  const rangeEnd = wallToUtc({ ...splitDate(addDaysToDateString(query.toDate, 1)), hour: 0, minute: 0 }, timeZone);

  const { ctx, memberProjects } = await loadCalendarContext(actor);
  const admin = isOrgAdmin(actor);
  const categories = new Set(query.types || DEFAULT_CATEGORIES[query.scope]);

  // ---- scope resolution (team scope needs a team the viewer may look at)
  let team = null;
  if (query.scope === CALENDAR_SCOPES.TEAM) {
    if (!query.teamId) throw new AppError('A team is required for the team calendar', 400, 'TEAM_REQUIRED');
    team = await Team.findOne({ _id: query.teamId, organization: actor.organization }).select('name members lead').lean();
    if (!team) throw new AppError('Team not found', 404, 'NOT_FOUND');
    const onTeam = ctx.teamIds.has(idOf(team._id));
    if (!onTeam && !isTeamAdmin(actor)) throw new AppError('You do not have access to this team', 403, 'FORBIDDEN');
  }
  const teamMemberIds = team ? [...new Set([...team.members.map(idOf), idOf(team.lead)].filter(Boolean))] : [];

  const teamProjectIds = team
    ? (await Project.find({ organization: actor.organization, deletedAt: null, team: team._id }).select('_id').lean()).map((p) => p._id)
    : [];

  // Projects whose meetings / tasks / deadlines the viewer may see: their own,
  // or (admins) every project in the organization.
  const memberProjectIds = memberProjects.map((project) => project._id);
  const scopeFilter = { admin, memberProjectIds, teamProjectIds, teamMemberIds, team, actor };

  const wantsEvents = Object.values(EVENT_TYPES).some((type) => categories.has(type));
  const results = await Promise.all([
    wantsEvents ? collectEvents({ query, ctx, rangeStart, rangeEnd, ...scopeFilter }) : empty(),
    categories.has('meeting') ? collectMeetings({ query, ctx, rangeStart, rangeEnd, ...scopeFilter }) : empty(),
    categories.has('task') ? collectTasks({ query, ctx, fromDateMs, toDateMs, ...scopeFilter }) : empty(),
    categories.has('project') ? collectProjects({ query, fromDateMs, toDateMs, ...scopeFilter }) : empty(),
  ]);

  const items = results.flatMap((result) => result.items).filter((item) => !item.category || categories.has(item.category));
  const truncated = results.some((result) => result.truncated);

  items.sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));

  return {
    items,
    truncated,
    range: { fromDate: query.fromDate, toDate: query.toDate, from: new Date(rangeStart).toISOString(), to: new Date(rangeEnd).toISOString() },
    timeZone,
    timeZoneSource,
    scope: query.scope,
  };
}

const empty = async () => ({ items: [], truncated: false });
const splitDate = (value) => {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
};
// Sort all-day items (by date) before timed items on the same day.
const sortKey = (item) => (item.allDay ? parseDateOnly(item.startDate) : new Date(item.start).getTime());

const matches = (regex, ...values) => values.some((value) => value && regex.test(value));

// ---- calendar events -----------------------------------------------------------

async function collectEvents({ query, ctx, rangeStart, rangeEnd, teamProjectIds, team, actor }) {
  const rangeFilter = {
    $or: [
      // One-off events overlapping the window.
      { recurrence: null, start: { $lt: new Date(rangeEnd) }, end: { $gt: new Date(rangeStart) } },
      // Series that started before the window ends and haven't finished before it begins.
      {
        recurrence: { $ne: null },
        start: { $lt: new Date(rangeEnd) },
        $or: [{ 'recurrence.until': null }, { 'recurrence.until': { $gte: new Date(rangeStart - 7 * DAY_MS) } }],
      },
    ],
  };

  const and = [rangeFilter, buildEventVisibilityFilter(ctx)];
  if (query.scope === CALENDAR_SCOPES.ORGANIZATION) and.push({ type: EVENT_TYPES.ORGANIZATION });
  if (query.scope === CALENDAR_SCOPES.TEAM) {
    and.push({ $or: [{ team: team._id }, ...(teamProjectIds.length ? [{ project: { $in: teamProjectIds } }] : [])] });
  }
  if (query.projectId) and.push({ project: query.projectId });
  if (query.assigneeId) and.push({ $or: [{ owner: query.assigneeId }, { 'attendees.user': query.assigneeId }] });
  if (query.q) {
    const regex = new RegExp(escapeRegex(query.q), 'i');
    and.push({ $or: [{ title: regex }, { description: regex }, { location: regex }] });
  }
  const wantedTypes = Object.values(EVENT_TYPES).filter((type) => !query.types || query.types.includes(type));
  and.push({ type: { $in: wantedTypes } });
  and.push({ organization: actor.organization, deletedAt: null, status: EVENT_STATUS.ACTIVE });

  const docs = await CalendarEvent.find({ $and: and }).limit(LIMITS.MAX_ITEMS_PER_SOURCE).lean();
  const truncated = docs.length >= LIMITS.MAX_ITEMS_PER_SOURCE;

  // `status` filter: calendar events here are always "active".
  if (query.status && query.status.toLowerCase() !== EVENT_STATUS.ACTIVE) return { items: [], truncated };

  const viewable = docs.filter((event) => canViewEvent(ctx, event));
  const names = await loadNames(viewable);
  const items = [];
  let budget = LIMITS.MAX_OCCURRENCES_PER_REQUEST;
  let capped = false;

  for (const event of viewable) {
    const base = eventPayload(event, { ctx, names });
    const startMs = event.start.getTime();
    const endMs = event.end.getTime();

    const push = (originalStart, start, end, overrides = {}) => {
      if (budget <= 0) {
        capped = true;
        return;
      }
      budget -= 1;
      items.push({
        id: event.recurrence ? `event:${base.eventId}:${originalStart}` : `event:${base.eventId}`,
        source: ITEM_SOURCES.EVENT,
        ...base,
        ...overrides,
        occurrenceStart: event.recurrence ? originalStart : null,
        ...timedFields(event, start, end),
        status: EVENT_STATUS.ACTIVE,
      });
    };

    if (!event.recurrence) {
      push(startMs, startMs, endMs);
      continue; // eslint-disable-line no-continue
    }

    const series = { start: startMs, end: endMs, allDay: event.allDay, timezone: event.timezone, recurrence: event.recurrence };
    const exceptions = new Map(event.exceptions.map((entry) => [entry.originalStart.getTime(), entry]));

    expandRecurrence(series, rangeStart, rangeEnd, { limit: budget + 1 }).forEach((occurrence) => {
      const exception = exceptions.get(occurrence.originalStart);
      if (exception) return; // handled below (moved/edited/cancelled occurrences)
      push(occurrence.originalStart, occurrence.start, occurrence.end);
    });

    // Occurrences that were edited or moved. A moved one can land inside the
    // window even though its original slot is outside it, so check them directly.
    exceptions.forEach((exception, originalStart) => {
      if (exception.cancelled) return;
      const start = exception.start ? exception.start.getTime() : originalStart;
      const end = exception.end ? exception.end.getTime() : start + (endMs - startMs);
      if (!(end > rangeStart && start < rangeEnd)) return;
      push(originalStart, start, end, {
        ...(exception.title !== undefined ? { title: exception.title } : {}),
        ...(exception.description !== undefined ? { description: exception.description } : {}),
        ...(exception.location !== undefined ? { location: exception.location } : {}),
        ...(exception.meetingUrl !== undefined ? { meetingUrl: exception.meetingUrl } : {}),
        modified: true,
      });
    });
  }

  return { items, truncated: truncated || capped };
}

// ---- meetings (read-only, from the Meeting collection) ---------------------------------

async function collectMeetings({ query, ctx, rangeStart, rangeEnd, admin, memberProjectIds, teamProjectIds, teamMemberIds, actor }) {
  const and = [
    { organization: actor.organization, deletedAt: null },
    // A meeting may have started up to a day before the window and still overlap it.
    { startTime: { $lt: new Date(rangeEnd), $gte: new Date(rangeStart - DAY_MS) } },
  ];
  if (!admin) and.push({ project: { $in: memberProjectIds } }); // same rule as canViewMeeting: project members
  if (query.projectId) and.push({ project: query.projectId });
  if (query.includeCancelled !== 'true') and.push({ status: { $ne: MEETING_STATUS.CANCELLED } });
  if (query.status) and.push({ status: new RegExp(`^${escapeRegex(query.status)}$`, 'i') });
  if (query.assigneeId) and.push({ $or: [{ host: query.assigneeId }, { 'participants.user': query.assigneeId }] });
  if (query.q) and.push({ $or: [{ topic: new RegExp(escapeRegex(query.q), 'i') }, { description: new RegExp(escapeRegex(query.q), 'i') }] });

  if (query.scope === CALENDAR_SCOPES.PERSONAL) {
    and.push({ $or: [{ host: actor._id }, { 'participants.user': actor._id }] });
  } else if (query.scope === CALENDAR_SCOPES.TEAM) {
    and.push({ $or: [{ project: { $in: teamProjectIds } }, { 'participants.user': { $in: teamMemberIds } }, { host: { $in: teamMemberIds } }] });
  }

  const docs = await Meeting.find({ $and: and })
    .sort({ startTime: 1 })
    .limit(LIMITS.MAX_ITEMS_PER_SOURCE)
    .populate('host', 'firstName lastName')
    .populate('participants.user', 'firstName lastName')
    .lean();
  const truncated = docs.length >= LIMITS.MAX_ITEMS_PER_SOURCE;

  const projects = await loadProjects(docs.map((meeting) => meeting.project), actor.organization);
  const now = Date.now();
  const items = [];

  docs.forEach((meeting) => {
    const project = projects.get(idOf(meeting.project));
    if (!project || !canViewMeeting(ctx.user, project, meeting)) return; // authoritative check
    const start = meeting.startTime.getTime();
    const end = meeting.endTime ? meeting.endTime.getTime() : start + DEFAULT_MEETING_DURATION_MS;
    if (!(end > rangeStart && start < rangeEnd)) return;

    const live = meeting.status === MEETING_STATUS.ACTIVE || (meeting.status === MEETING_STATUS.SCHEDULED && now >= start - JOIN_WINDOW_MS);
    const joinable = live && canJoinMeeting(ctx.user, project, meeting);
    const participants = meeting.participants.map((entry) => ({ id: idOf(entry.user), name: fullName(entry.user), status: entry.status }));

    items.push({
      id: `meeting:${idOf(meeting._id)}`,
      source: ITEM_SOURCES.MEETING,
      category: 'meeting',
      title: meeting.topic,
      description: meeting.description,
      allDay: false,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      hasEndTime: Boolean(meeting.endTime),
      status: meeting.status,
      meetingType: meeting.type,
      host: { id: idOf(meeting.host), name: fullName(meeting.host) },
      participants: participants.slice(0, MAX_LISTED_PARTICIPANTS),
      participantCount: participants.length,
      project: { id: idOf(project._id), name: project.name },
      link: `/dashboard/projects/${idOf(project._id)}/meetings/${idOf(meeting._id)}`,
      joinLink: joinable ? `/meeting-room/${idOf(project._id)}/${idOf(meeting._id)}` : null,
      canJoin: Boolean(joinable),
      readOnly: true,
    });
  });

  return { items, truncated };
}

// ---- tasks (read-only; date-only deadlines) ---------------------------------------------------

async function collectTasks({ query, ctx, fromDateMs, toDateMs, admin, memberProjectIds, teamProjectIds, teamMemberIds, actor }) {
  const and = [
    { organization: actor.organization, deletedAt: null, archived: false },
    // dueDate is a date-only value stored at UTC midnight: compare it to UTC-midnight bounds.
    { dueDate: { $gte: new Date(fromDateMs), $lte: new Date(toDateMs) } },
  ];
  if (!admin) {
    and.push({ project: { $in: memberProjectIds } });
    // Mirrors canViewTask: Public tasks to project members; Private ones only to the people attached to them.
    const managed = [...ctx.managedProjectIds];
    and.push({ $or: [{ visibility: 'Public' }, { assignees: actor._id }, { approvers: actor._id }, ...(managed.length ? [{ project: { $in: managed } }] : [])] });
  }
  if (query.projectId) and.push({ project: query.projectId });
  if (query.status) and.push({ status: new RegExp(`^${escapeRegex(query.status)}$`, 'i') });
  if (query.assigneeId) and.push({ assignees: query.assigneeId });
  if (query.q) and.push({ title: new RegExp(escapeRegex(query.q), 'i') });

  if (query.scope === CALENDAR_SCOPES.PERSONAL) {
    and.push({ assignees: actor._id });
  } else if (query.scope === CALENDAR_SCOPES.TEAM) {
    and.push({ $or: [{ project: { $in: teamProjectIds } }, { assignees: { $in: teamMemberIds } }] });
  }

  const docs = await Task.find({ $and: and })
    .sort({ dueDate: 1 })
    .limit(LIMITS.MAX_ITEMS_PER_SOURCE)
    .populate('assignees', 'firstName lastName')
    .lean();
  const truncated = docs.length >= LIMITS.MAX_ITEMS_PER_SOURCE;

  const projects = await loadProjects(docs.map((task) => task.project), actor.organization);
  const items = [];

  docs.forEach((task) => {
    const project = projects.get(idOf(task.project));
    if (!project || !canViewTask(ctx.user, project, task)) return; // authoritative check
    const date = dateOnlyString(task.dueDate.getTime());
    items.push({
      id: `task:${idOf(task._id)}`,
      source: ITEM_SOURCES.TASK,
      category: 'task',
      title: task.title,
      allDay: true,
      startDate: date,
      endDate: date,
      start: null,
      end: null,
      status: task.status,
      priority: task.priority,
      done: task.status === 'Completed' || task.status === 'Cancelled',
      assignees: task.assignees.map((user) => ({ id: idOf(user), name: fullName(user) })),
      project: { id: idOf(project._id), name: project.name },
      link: `/dashboard/projects/${idOf(project._id)}/tasks/${idOf(task._id)}`,
      readOnly: true,
    });
  });

  return { items, truncated };
}

// ---- project deadlines (read-only; date-only) -----------------------------------------------------

async function collectProjects({ query, fromDateMs, toDateMs, admin, memberProjectIds, teamProjectIds, actor }) {
  const and = [
    { organization: actor.organization, deletedAt: null },
    { dueDate: { $gte: new Date(fromDateMs), $lte: new Date(toDateMs) } },
  ];
  if (!admin) and.push({ _id: { $in: memberProjectIds } });
  if (query.projectId) and.push({ _id: query.projectId });
  if (query.status) and.push({ status: new RegExp(`^${escapeRegex(query.status)}$`, 'i') });
  if (query.q) and.push({ name: new RegExp(escapeRegex(query.q), 'i') });
  if (query.scope === CALENDAR_SCOPES.TEAM) and.push({ _id: { $in: teamProjectIds } });
  // Projects have no assignees; an assignee filter means "tasks/meetings/events of that person" only.
  if (query.assigneeId) return { items: [], truncated: false };

  const docs = await Project.find({ $and: and }).select('name status dueDate').sort({ dueDate: 1 }).limit(LIMITS.MAX_ITEMS_PER_SOURCE).lean();
  const items = docs.map((project) => {
    const date = dateOnlyString(project.dueDate.getTime());
    return {
      id: `project:${idOf(project._id)}`,
      source: ITEM_SOURCES.PROJECT,
      category: 'project',
      title: project.name,
      allDay: true,
      startDate: date,
      endDate: date,
      start: null,
      end: null,
      status: project.status,
      done: project.status === 'Completed' || project.status === 'Archived',
      project: { id: idOf(project._id), name: project.name },
      link: `/dashboard/projects/${idOf(project._id)}`,
      readOnly: true,
    };
  });
  return { items, truncated: docs.length >= LIMITS.MAX_ITEMS_PER_SOURCE };
}

async function loadProjects(ids, organization) {
  const unique = [...new Set(ids.map(idOf))];
  if (!unique.length) return new Map();
  const projects = await Project.find({ _id: { $in: unique }, organization, deletedAt: null })
    .select('name owner members team organization')
    .lean();
  return new Map(projects.map((project) => [idOf(project._id), project]));
}

module.exports = { getCalendar };
