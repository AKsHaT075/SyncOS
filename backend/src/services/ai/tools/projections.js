const { OPEN_TASK_STATUSES } = require('../../../constants/analytics.constants');
const { resolveToolLimits } = require('./toolLimits');

/**
 * AI PROJECTIONS: the ONLY way organizational records become tool output. Each function builds a brand-new plain object
 * from an EXPLICIT list of fields; nothing is copied wholesale, nothing is spread from the source, and nothing here calls a
 * product serializer (`toSafeObject`, `serializePerson`, ...). A field that is not written below cannot appear, whatever the
 * record contains.
 *
 * What these never emit (not "filtered", simply absent from every projection): task description, comments, checklist,
 * attachments and file metadata, submissions and review remarks, estimates, labels, tags; project description, client, budget,
 * links, slug; any email address or phone number; authentication or session data; LiveKit room names and every join link or
 * meeting URL; meeting and event descriptions, locations, notes; participant lists beyond a count; internal ids other than the
 * public id of the record itself.
 *
 * Shapes: plain JSON only. Ids are 24-hex strings; dates are date-only 'YYYY-MM-DD' (floating deadlines, never shifted) or ISO-8601
 * UTC instants; strings are cleaned and length-bounded; arrays are bounded; enums keep the product's own stable values. Each shape
 * has a strict zod allowlist in projectionSchemas.js, and the tool-result validator (toolResult.js) is applied on top of it.
 *
 * Free text that came from users (titles, names, topics) is untrusted DATA: control and zero-width characters are removed,
 * whitespace is collapsed, and any URL (a scheme, or www.) is replaced by "[link removed]" so a record can never smuggle an
 * external link into an answer (decision D5). Links to live records are generated HERE from validated ids, never copied.
 */

const LIMITS = Object.freeze({ name: 120, title: 160, people: 10, members: 50 });
const REMOVED = '[link removed]';
const HEX24 = /^[a-f0-9]{24}$/i;

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]', 'g');
const URLISH = /\b(?:https?|ftp|ftps|file|data|javascript|vbscript|mailto|tel|sms):[^\s]*|\bwww\.[^\s]*/gi;

/** Untrusted text -> a bounded single line with no control characters and no URLs. */
function cleanText(value, max = LIMITS.name) {
  const text = String(value ?? '').replace(CONTROL, ' ').replace(URLISH, REMOVED).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An ObjectId / populated reference / string -> its 24-hex id string, or null when it is not one. */
function idString(value) {
  const raw = value && typeof value === 'object' && value._id ? value._id : value;
  const text = raw === null || raw === undefined ? '' : String(raw);
  return HEX24.test(text) ? text.toLowerCase() : null;
}

/** Date / ISO string -> 'YYYY-MM-DD' (UTC calendar date: the form floating deadlines are stored in), or null. */
function dateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Date / ISO string -> ISO-8601 UTC instant 'YYYY-MM-DDTHH:mm:ss.sssZ', or null. */
function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1_000_000) : 0);

// ---- links to live records: built here from validated ids, never taken from stored data --------------------------------
const href = {
  project: (projectId) => `/dashboard/projects/${projectId}`,
  task: (projectId, taskId) => `/dashboard/projects/${projectId}/tasks/${taskId}`,
  meeting: (projectId, meetingId) => `/dashboard/projects/${projectId}/meetings/${meetingId}`,
  calendar: () => '/dashboard/calendar',
};

/** Display name for a populated user, or for an id looked up in `names` (Map of id -> display name). Unknown people are "Former member". */
function personName(value, names) {
  const populated = value && typeof value === 'object' && (value.firstName !== undefined || value.lastName !== undefined)
    ? cleanText(`${value.firstName || ''} ${value.lastName || ''}`)
    : '';
  const id = idString(value);
  const fromMap = id && names && typeof names.get === 'function' ? names.get(id) : '';
  return populated || cleanText(fromMap) || 'Former member';
}

/** Whole names joined with "; " until the string budget is used ("…" when some were left out). Keeps a row's list inside ONE bounded string. */
function nameList(values, names, { max = 8, budget = 160 } = {}) {
  const out = [];
  let used = 0;
  let omitted = false;
  for (const value of (values || []).filter((v) => idString(v))) {
    const name = personName(value, names);
    if (out.length >= max || used + name.length + 2 > budget) {
      omitted = true;
      break;
    }
    out.push(name);
    used += name.length + 2;
  }
  return out.length ? `${out.join('; ')}${omitted ? '; …' : ''}` : '';
}

// ---- projections ----------------------------------------------------------------------------------------------------------
//
// DEPTH: the tool-result validator allows depth 4 and a tool wraps rows as { data: [row], summary: {...} } (root 1, array 2, row 3, row
// fields 4). So a ROW is FLAT: primitives only. A person is a name string, a list of people is one bounded string plus a count,
// and a project reference is two fields (projectId, projectName). The validator is not relaxed to fit richer rows.

/** `today` = 'YYYY-MM-DD' in the user's zone, computed by Node. Overdue = an OPEN task whose due date is before today (due today is not overdue). */
function projectTask(task, { names = null, project = null, today = null } = {}) {
  const id = idString(task._id);
  const projectId = idString(project?._id ?? task.project);
  const due = dateOnly(task.dueDate);
  const assignees = task.assignees || [];
  return {
    id,
    title: cleanText(task.title, LIMITS.title),
    status: task.status,
    priority: task.priority,
    due,
    overdue: Boolean(due && today && OPEN_TASK_STATUSES.includes(task.status) && due < today),
    projectId,
    projectName: projectId ? cleanText(project?.name ?? task.project?.name ?? 'Project', LIMITS.title) || 'Project' : null,
    assignees: nameList(assignees, names),
    assigneeCount: assignees.filter((user) => idString(user)).length,
    href: id && projectId ? href.task(projectId, id) : null,
  };
}

/** `counts` (optional) = { open, overdue } computed by the caller under the AI task rule, so a count never reveals tasks the user cannot see. */
function projectProject(project, { names = null, counts = null, today = null } = {}) {
  const id = idString(project._id);
  const due = dateOnly(project.dueDate);
  const members = new Set([idString(project.owner), ...(project.members || []).map((m) => idString(m.user))].filter(Boolean));
  const out = {
    id,
    name: cleanText(project.name, LIMITS.title),
    status: project.status,
    priority: project.priority,
    type: project.type,
    start: dateOnly(project.startDate),
    due,
    pastDue: Boolean(due && today && ['Planning', 'Active', 'On Hold'].includes(project.status) && due < today),
    owner: idString(project.owner) ? personName(project.owner, names) : null,
    memberCount: members.size,
    href: id ? href.project(id) : null,
  };
  if (counts) {
    out.openTasks = count(counts.open);
    out.overdueTasks = count(counts.overdue);
  }
  return out;
}

/** One entry of a project's roster (the owner field is its own entry with role Owner). Flat. */
function projectProjectMember(entry, { names = null } = {}) {
  const id = idString(entry.user);
  return id ? { id, name: personName(entry.user, names), projectRole: entry.role } : null;
}

/** The full roster of a visible project: the owner first, then listed members (the owner is not listed twice). */
function projectRoster(project, { names = null } = {}) {
  const ownerId = idString(project.owner);
  const roster = [];
  if (ownerId) roster.push({ id: ownerId, name: personName(project.owner, names), projectRole: 'Owner' });
  for (const entry of project.members || []) {
    if (idString(entry.user) === ownerId) continue;
    const row = projectProjectMember(entry, { names });
    if (row) roster.push(row);
    if (roster.length >= LIMITS.members) break;
  }
  return roster;
}

/**
 * A team. `members` (names only, an array of strings: depth-safe inside { team: {...} }) is for a single-team DETAIL result; a LIST of
 * teams must pass includeMembers:false so its rows stay flat.
 */
function projectTeam(team, { names = null, includeMembers = true } = {}) {
  const memberIds = [...new Set((team.members || []).map(idString).filter(Boolean))];
  const out = {
    id: idString(team._id),
    name: cleanText(team.name, LIMITS.title),
    lead: idString(team.lead) ? personName(team.lead, names) : null,
    memberCount: memberIds.length,
  };
  if (includeMembers) out.members = memberIds.slice(0, LIMITS.members).map((id) => personName(id, names));
  return out;
}

/** A person as AI may describe them: name, organization role, team name. No contact details, no status flags, no skills, no presence. */
function projectPerson(person, { teamName = null } = {}) {
  return {
    id: idString(person._id),
    name: cleanText(`${person.firstName || ''} ${person.lastName || ''}`),
    role: person.role,
    team: teamName ? cleanText(teamName) : null,
  };
}

function projectMeeting(meeting, { names = null, project = null } = {}) {
  const id = idString(meeting._id);
  const projectId = idString(project?._id ?? meeting.project);
  return {
    id,
    topic: cleanText(meeting.topic, LIMITS.title),
    status: meeting.status,
    type: meeting.type,
    start: instant(meeting.startTime),
    end: instant(meeting.endTime),
    host: idString(meeting.host) ? personName(meeting.host, names) : null,
    participantCount: (meeting.participants || []).length,
    projectId,
    projectName: projectId ? cleanText(project?.name ?? meeting.project?.name ?? 'Project', LIMITS.title) || 'Project' : null,
    href: id && projectId ? href.meeting(projectId, id) : null,
  };
}

const CALENDAR_SOURCES = new Set(['meeting', 'task', 'project', 'event']);

/**
 * One entry of a schedule, from the unified calendar item shape (calendarQuery) or the same fields built by a tool. Anything the
 * item carries beyond the fields below (description, location, meetingUrl, joinLink, attendees, participants, link, ...) is dropped.
 * Returns null for an item it cannot represent safely. Flat.
 */
function projectCalendarEntry(item) {
  const [source, rawId, occurrence] = String(item?.id || '').split(':');
  const id = idString(rawId);
  if (!CALENDAR_SOURCES.has(source) || !id) return null;
  const projectId = idString(item.project?.id ?? item.project);
  let link = null;
  if (source === 'meeting' && projectId) link = href.meeting(projectId, id);
  else if (source === 'task' && projectId) link = href.task(projectId, id);
  else if (source === 'project') link = href.project(id);
  else if (source === 'event') link = href.calendar();
  return {
    id: `${source}:${id}${occurrence && /^\d{1,16}$/.test(occurrence) ? `:${occurrence}` : ''}`,
    category: source === 'event' ? cleanText(item.category || 'event', 20).toLowerCase() : source,
    title: cleanText(item.title, LIMITS.title),
    allDay: Boolean(item.allDay),
    start: instant(item.start),
    end: instant(item.end),
    startDate: dateOnly(item.startDate),
    endDate: dateOnly(item.endDate),
    status: item.status ? cleanText(item.status, 20) : null,
    projectId,
    projectName: projectId ? cleanText(item.project?.name || 'Project', LIMITS.title) || 'Project' : null,
    href: link,
  };
}

/**
 * Keeps as many leading rows as fit in the result budget (serialized bytes, minus room for the rest of the result), so a list tool
 * returns FEWER rows and says so (`truncated`) instead of producing a result the gate would refuse for size. Rows are never cut.
 */
function fitRows(rows, { maxBytes = resolveToolLimits().maxResultBytes, reserveBytes = 400, maxRows = resolveToolLimits().maxRecords } = {}) {
  const kept = [];
  let used = reserveBytes;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (kept.length >= maxRows || used + size > maxBytes) return { rows: kept, truncated: true };
    kept.push(row);
    used += size;
  }
  return { rows: kept, truncated: false };
}

module.exports = {
  fitRows, LIMITS, cleanText, dateOnly, href, idString, instant, nameList, personName,
  projectCalendarEntry, projectMeeting, projectPerson, projectProject, projectProjectMember, projectRoster, projectTask, projectTeam,
};
