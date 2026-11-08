const { NOTIFICATION_CATEGORIES: C, NOTIFICATION_TARGETS: T } = require('./notification.constants');
const { buildMeetingInvitationEmail, buildMeetingRequestDecisionEmail } = require('../utils/emailTemplates');

/**
 * Catalogue of every notification the system can emit.
 *
 *  category   preference bucket (security is not configurable)
 *  target     what the notification points at (drives the link + access check)
 *  link       false => never rendered as a link (e.g. "you were removed from X")
 *  email      true  => eligible for email (user preference still applies; the
 *                       security category always emails)
 *  title      generic, contains no resource names
 *  message    the only place names appear — withheld if access is later lost
 *  renderEmail optional override reusing existing email copy
 *
 * Only meaningful events are listed; minor edits deliberately are not.
 */
const NOTIFICATION_TYPES = Object.freeze({
  // ---- tasks
  'task.assigned': {
    category: C.TASK, target: T.TASK, link: true, email: true,
    title: 'Task assigned',
    message: ({ actor, p }) => `${actor} assigned you “${p.task}”${p.project ? ` in ${p.project}` : ''}.`,
  },
  'task.unassigned': {
    category: C.TASK, target: T.TASK, link: false,
    title: 'Removed from a task',
    message: ({ actor, p }) => `${actor} removed you from “${p.task}”.`,
  },
  'task.status_changed': {
    category: C.TASK, target: T.TASK, link: true,
    title: 'Task status changed',
    message: ({ actor, p }) => `${actor} moved “${p.task}” to ${p.status}.`,
  },
  'task.submitted': {
    category: C.TASK, target: T.TASK, link: true,
    title: 'Task submitted for review',
    message: ({ actor, p }) => `${actor} submitted “${p.task}” for your review.`,
  },
  'task.approved': {
    category: C.TASK, target: T.TASK, link: true,
    title: 'Task update approved',
    message: ({ actor, p }) => `${actor} approved your update on “${p.task}”.`,
  },
  'task.rejected': {
    category: C.TASK, target: T.TASK, link: true, email: true,
    title: 'Task update rejected',
    message: ({ actor, p }) => `${actor} rejected your update on “${p.task}”.`,
  },
  'task.changes_requested': {
    category: C.TASK, target: T.TASK, link: true, email: true,
    title: 'Changes requested',
    message: ({ actor, p }) => `${actor} requested changes on “${p.task}”.`,
  },

  // ---- projects
  'project.member_added': {
    category: C.PROJECT, target: T.PROJECT, link: true,
    title: 'Added to a project',
    message: ({ actor, p }) => `${actor} added you to “${p.project}” as ${p.role}.`,
  },
  'project.member_removed': {
    category: C.PROJECT, target: T.PROJECT, link: false,
    title: 'Removed from a project',
    message: ({ actor, p }) => `${actor} removed you from “${p.project}”.`,
  },
  'project.role_changed': {
    category: C.PROJECT, target: T.PROJECT, link: true,
    title: 'Project role changed',
    message: ({ actor, p }) => `${actor} changed your role in “${p.project}” to ${p.role}.`,
  },
  'project.ownership_received': {
    category: C.PROJECT, target: T.PROJECT, link: true,
    title: 'You now own a project',
    message: ({ actor, p }) => `${actor} made you the owner of “${p.project}”.`,
  },
  'project.ownership_removed': {
    category: C.PROJECT, target: T.PROJECT, link: true,
    title: 'Project ownership transferred',
    message: ({ actor, p }) => `${actor} transferred ownership of “${p.project}” to ${p.newOwner}.`,
  },
  'project.archived': {
    category: C.PROJECT, target: T.PROJECT, link: true,
    title: 'Project archived',
    message: ({ actor, p }) => `${actor} archived “${p.project}”.`,
  },
  'project.deleted': {
    category: C.PROJECT, target: T.PROJECT, link: false,
    title: 'Project deleted',
    message: ({ actor, p }) => `${actor} deleted “${p.project}”.`,
  },

  // ---- meetings
  'meeting.invited': {
    category: C.MEETING, target: T.MEETING, link: true, email: true,
    title: 'Meeting invitation',
    message: ({ actor, p }) => `${actor} invited you to “${p.topic}”${p.project ? ` in ${p.project}` : ''}.`,
    renderEmail: ({ p, url }) =>
      buildMeetingInvitationEmail({ meetingTopic: p.topic, projectName: p.project, startTime: p.startTime, joinUrl: url }),
  },
  'meeting.removed': {
    category: C.MEETING, target: T.MEETING, link: false,
    title: 'Removed from a meeting',
    message: ({ actor, p }) => `${actor} removed you from “${p.topic}”.`,
  },
  'meeting.updated': {
    category: C.MEETING, target: T.MEETING, link: true,
    title: 'Meeting updated',
    message: ({ actor, p }) => `${actor} changed the details of “${p.topic}”.`,
  },
  'meeting.cancelled': {
    category: C.MEETING, target: T.MEETING, link: true, email: true,
    title: 'Meeting cancelled',
    message: ({ actor, p }) => `${actor} cancelled “${p.topic}”.`,
  },
  'meeting.reminder': {
    category: C.MEETING, target: T.MEETING, link: true,
    title: 'Meeting starting soon',
    message: ({ p }) => `“${p.topic}” starts in about ${p.minutes} minute${p.minutes === 1 ? '' : 's'}.`,
  },
  'meeting_request.received': {
    category: C.MEETING, target: T.MEETING_REQUEST, link: true,
    title: 'Meeting request received',
    message: ({ actor, p }) => `${actor} requested a meeting: “${p.topic}”.`,
  },
  'meeting_request.approved': {
    category: C.MEETING, target: T.MEETING_REQUEST, link: true, email: true,
    title: 'Meeting request approved',
    message: ({ actor, p }) => `${actor} approved your request “${p.topic}”.`,
    renderEmail: ({ p }) => buildMeetingRequestDecisionEmail({ topic: p.topic, status: p.status || 'Approved', remarks: p.remarks }),
  },
  'meeting_request.rejected': {
    category: C.MEETING, target: T.MEETING_REQUEST, link: true, email: true,
    title: 'Meeting request declined',
    message: ({ actor, p }) => `${actor} declined your request “${p.topic}”.`,
    renderEmail: ({ p }) => buildMeetingRequestDecisionEmail({ topic: p.topic, status: 'Rejected', remarks: p.remarks }),
  },

  // ---- people & teams
  'team.member_added': {
    category: C.TEAM, target: T.TEAM, link: true,
    title: 'Added to a team',
    message: ({ actor, p }) => `${actor} added you to the ${p.team} team.`,
  },
  'team.member_removed': {
    category: C.TEAM, target: T.TEAM, link: false,
    title: 'Removed from a team',
    message: ({ actor, p }) => `${actor} removed you from the ${p.team} team.`,
  },
  'team.manager_assigned': {
    category: C.TEAM, target: T.TEAM, link: true,
    title: 'You manage a team',
    message: ({ actor, p }) => `${actor} made you the manager of the ${p.team} team.`,
  },
  'team.manager_removed': {
    category: C.TEAM, target: T.TEAM, link: false,
    title: 'Team manager changed',
    message: ({ actor, p }) => `${actor} replaced you as manager of the ${p.team} team.`,
  },
  'person.role_changed': {
    category: C.TEAM, target: null, link: false, email: true,
    title: 'Your role changed',
    message: ({ actor, p }) => `${actor} changed your role to ${p.role}.`,
  },

  // ---- documents
  'document.shared': {
    category: C.DOCUMENT, target: T.DOCUMENT, link: true, email: true,
    title: 'Document shared with you',
    message: ({ actor, p }) => `${actor} shared “${p.document}” with you as ${p.permission}.`,
  },
  'document.access_revoked': {
    category: C.DOCUMENT, target: T.DOCUMENT, link: false,
    title: 'Document access removed',
    message: ({ actor, p }) => `${actor} removed your direct access to “${p.document}”.`,
  },
  'document.version_uploaded': {
    category: C.DOCUMENT, target: T.DOCUMENT, link: true,
    title: 'New document version',
    message: ({ actor, p }) => `${actor} ${p.restored ? 'restored an earlier version of' : 'uploaded a new version of'} “${p.document}”.`,
  },

  // ---- calendar
  'calendar.event_invited': {
    category: C.CALENDAR, target: T.CALENDAR_EVENT, link: true, email: true,
    title: 'Event invitation',
    message: ({ actor, p }) => `${actor} invited you to “${p.event}”.`,
  },
  'calendar.event_updated': {
    category: C.CALENDAR, target: T.CALENDAR_EVENT, link: true,
    title: 'Event updated',
    message: ({ actor, p }) => `${actor} changed “${p.event}”.`,
  },
  // No link: the event is gone (or this occurrence is), and the message must stay readable.
  'calendar.event_cancelled': {
    category: C.CALENDAR, target: T.CALENDAR_EVENT, link: false, email: true,
    title: 'Event cancelled',
    message: ({ actor, p }) => `${actor} cancelled “${p.event}”${p.occurrence ? ' (one occurrence)' : ''}.`,
  },
  // Emailed only when the event's reminder asked for email AND the user allows calendar email.
  'calendar.reminder': {
    category: C.CALENDAR, target: T.CALENDAR_EVENT, link: true, email: true, emailOptIn: true,
    title: 'Event starting soon',
    message: ({ p }) => `“${p.event}” starts in about ${p.when}.`,
  },

  // ---- security (always on; not configurable)
  'security.access_restored': {
    category: C.SECURITY, target: null, link: false, email: true,
    title: 'Your access was restored',
    message: () => 'An administrator restored your access to the organization.',
  },
  'security.password_reset_forced': {
    category: C.SECURITY, target: null, link: false,
    title: 'Your password was reset by an administrator',
    message: () => 'All of your sessions were signed out. If you did not expect this, contact your administrator.',
  },
});

/**
 * Account-level emails for people who can no longer open the app (blocked or
 * removed). Never persisted as in-app notifications — there is nobody inside
 * the organization to show them to — and they reveal only the organization name.
 */
const ACCOUNT_EMAIL_TYPES = Object.freeze({
  'security.access_blocked': ({ org }) => ({
    heading: `Your access to ${org} has been suspended`,
    body: `An administrator suspended your access to ${org} on Sync OS. If you think this is a mistake, please contact your organization administrator.`,
  }),
  'security.removed_from_org': ({ org }) => ({
    heading: `You were removed from ${org}`,
    body: `An administrator removed you from ${org} on Sync OS. You no longer have access to its workspace. Your account still exists and can be invited to another organization.`,
  }),
});

module.exports = { ACCOUNT_EMAIL_TYPES, NOTIFICATION_TYPES };
