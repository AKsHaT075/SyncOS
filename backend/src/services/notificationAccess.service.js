const Asset = require('../models/Asset');
const CalendarEvent = require('../models/CalendarEvent');
const Document = require('../models/Document');
const Meeting = require('../models/Meeting');
const MeetingRequest = require('../models/MeetingRequest');
const Project = require('../models/Project');
const Task = require('../models/Task');
const Team = require('../models/Team');
const { NOTIFICATION_TARGETS: T } = require('../constants/notification.constants');
const { NOTIFICATION_TYPES } = require('../constants/notificationTypes');
const { canViewAsset } = require('../utils/assetAccess');
const { canViewEvent } = require('../utils/calendarAccess');
const { resolveDocumentAccess } = require('../utils/documentAccess');
const { canScheduleMeeting, canViewMeeting } = require('../utils/meetingAccess');
const { canViewProject } = require('../utils/projectAccess');
const { canViewTask } = require('../utils/taskAccess');
const { canViewTeam } = require('../utils/teamAccess');
const { loadAccessContext } = require('./documentAccess.service');
const { loadAssetContext } = require('./assetContext');
const { loadCalendarContext } = require('./calendarContext');

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);

function buildLink(target) {
  if (!target?.type || !target.id) return null;
  const id = idOf(target.id);
  const project = idOf(target.project);
  switch (target.type) {
    case T.TASK:
      return project ? `/dashboard/projects/${project}/tasks/${id}` : null;
    case T.PROJECT:
      return `/dashboard/projects/${id}`;
    case T.MEETING:
      return project ? `/dashboard/projects/${project}/meetings/${id}` : null;
    case T.MEETING_REQUEST:
      return project ? `/dashboard/projects/${project}/meetings/requests` : null;
    case T.DOCUMENT:
      return `/dashboard/documents?doc=${id}`;
    case T.TEAM:
      return '/dashboard/my-team';
    case T.CALENDAR_EVENT:
      return `/dashboard/calendar?event=${id}`;
    case T.ASSET:
      return `/dashboard/assets/${id}`;
    default:
      return null;
  }
}

const byId = (docs) => new Map(docs.map((doc) => [doc._id.toString(), doc]));

/**
 * Decides, for the CURRENT user right NOW, whether each notification's
 * destination is still reachable, using the very same access rules the
 * modules enforce. Batched per resource type (one or two queries each), so a
 * page of 20 notifications costs a handful of queries, not 20+.
 *
 * Returns Map(notificationId -> { link, available }):
 *   - types that never link (e.g. "you were removed from X")  -> link null, available true
 *   - accessible resource                                       -> link, available true
 *   - deleted / no longer permitted                             -> link null, available false
 */
async function resolveAccess(user, notifications) {
  const result = new Map();
  const pending = { [T.TASK]: [], [T.PROJECT]: [], [T.MEETING]: [], [T.MEETING_REQUEST]: [], [T.DOCUMENT]: [], [T.TEAM]: [], [T.CALENDAR_EVENT]: [], [T.ASSET]: [] };

  notifications.forEach((notification) => {
    const def = NOTIFICATION_TYPES[notification.type];
    const key = notification._id.toString();
    if (!def || !def.link || !notification.target?.type || !notification.target?.id) {
      result.set(key, { link: null, available: true });
      return;
    }
    (pending[notification.target.type] || []).push(notification);
  });

  const organization = user.organization;
  const verdicts = new Map(); // notificationId -> boolean

  const loadProjects = async (ids) => {
    const unique = [...new Set(ids.filter(Boolean).map(idOf))];
    if (!unique.length) return new Map();
    return byId(await Project.find({ _id: { $in: unique }, organization, deletedAt: null }).lean());
  };

  // tasks
  if (pending[T.TASK].length) {
    const tasks = byId(await Task.find({ _id: { $in: pending[T.TASK].map((n) => n.target.id) }, organization, deletedAt: null }).lean());
    const projects = await loadProjects([...tasks.values()].map((task) => task.project));
    pending[T.TASK].forEach((n) => {
      const task = tasks.get(idOf(n.target.id));
      const project = task && projects.get(idOf(task.project));
      verdicts.set(n._id.toString(), Boolean(task && project && canViewTask(user, project, task)));
    });
  }

  // projects
  if (pending[T.PROJECT].length) {
    const projects = await loadProjects(pending[T.PROJECT].map((n) => n.target.id));
    pending[T.PROJECT].forEach((n) => {
      const project = projects.get(idOf(n.target.id));
      verdicts.set(n._id.toString(), Boolean(project && canViewProject(user, project)));
    });
  }

  // meetings
  if (pending[T.MEETING].length) {
    const meetings = byId(await Meeting.find({ _id: { $in: pending[T.MEETING].map((n) => n.target.id) }, organization, deletedAt: null }).lean());
    const projects = await loadProjects([...meetings.values()].map((meeting) => meeting.project));
    pending[T.MEETING].forEach((n) => {
      const meeting = meetings.get(idOf(n.target.id));
      const project = meeting && projects.get(idOf(meeting.project));
      verdicts.set(n._id.toString(), Boolean(meeting && project && canViewMeeting(user, project, meeting)));
    });
  }

  // meeting requests: the requester, or someone who can decide on them
  if (pending[T.MEETING_REQUEST].length) {
    const requests = byId(await MeetingRequest.find({ _id: { $in: pending[T.MEETING_REQUEST].map((n) => n.target.id) }, organization }).lean());
    const projects = await loadProjects([...requests.values()].map((request) => request.project));
    pending[T.MEETING_REQUEST].forEach((n) => {
      const request = requests.get(idOf(n.target.id));
      const project = request && projects.get(idOf(request.project));
      const allowed =
        Boolean(request && project) &&
        (idOf(request.requestedBy) === idOf(user._id) || canScheduleMeeting(user, project));
      verdicts.set(n._id.toString(), allowed);
    });
  }

  // documents
  if (pending[T.DOCUMENT].length) {
    const documents = byId(await Document.find({ _id: { $in: pending[T.DOCUMENT].map((n) => n.target.id) }, organization, deletedAt: null }).lean());
    const ctx = await loadAccessContext(user);
    pending[T.DOCUMENT].forEach((n) => {
      const document = documents.get(idOf(n.target.id));
      verdicts.set(n._id.toString(), Boolean(document && resolveDocumentAccess(ctx, document).canView));
    });
  }

  // calendar events
  if (pending[T.CALENDAR_EVENT].length) {
    const events = byId(await CalendarEvent.find({ _id: { $in: pending[T.CALENDAR_EVENT].map((n) => n.target.id) }, organization, deletedAt: null }).lean());
    const { ctx } = await loadCalendarContext(user);
    pending[T.CALENDAR_EVENT].forEach((n) => {
      const event = events.get(idOf(n.target.id));
      verdicts.set(n._id.toString(), Boolean(event && canViewEvent(ctx, event)));
    });
  }

  // assets
  if (pending[T.ASSET].length) {
    const assets = byId(await Asset.find({ _id: { $in: pending[T.ASSET].map((n) => n.target.id) }, organization, deletedAt: null })
      .select('organization assignedUser assignedTeam team').lean());
    const ctx = await loadAssetContext(user);
    pending[T.ASSET].forEach((n) => {
      const asset = assets.get(idOf(n.target.id));
      verdicts.set(n._id.toString(), Boolean(asset && canViewAsset(ctx, asset)));
    });
  }

  // teams
  if (pending[T.TEAM].length) {
    const teams = byId(await Team.find({ _id: { $in: pending[T.TEAM].map((n) => n.target.id) }, organization }).lean());
    pending[T.TEAM].forEach((n) => {
      const team = teams.get(idOf(n.target.id));
      verdicts.set(n._id.toString(), Boolean(team && canViewTeam(user, team)));
    });
  }

  notifications.forEach((notification) => {
    const key = notification._id.toString();
    if (result.has(key)) return;
    const available = verdicts.get(key) === true;
    result.set(key, { link: available ? buildLink(notification.target) : null, available });
  });

  return result;
}

module.exports = { buildLink, resolveAccess };
