const { MEETING_PARTICIPANT_STATUS } = require('../constants/meeting.constants');
const { REMINDER_LEAD_MS } = require('../constants/notification.constants');
const { PROJECT_MEMBER_ROLES } = require('../constants/project.constants');
const { TASK_REVIEW_ACTION, TASK_STATUS } = require('../constants/task.constants');
const Organization = require('../models/Organization');
const { notify, safely } = require('./notification.service');
const { sendAccountEmail } = require('./notificationEmail.service');

/**
 * Domain events → notifications. Business services call ONE function here
 * after their own work has succeeded. Every function:
 *   - never throws (a notification problem must not fail the operation),
 *   - derives recipients from the resource's own membership data,
 *   - supplies a deterministic `occurrence` so the same event can't notify
 *     twice while a genuinely new one still does.
 *
 * What is deliberately NOT notified: task edits other than assignment/status,
 * project metadata edits, file uploads, comments on one's own actions, etc.
 */

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const ms = (date) => (date ? new Date(date).getTime() : Date.now());
const diff = (a, b) => a.filter((id) => !b.includes(id));
const ids = (list) => (list || []).map(idOf).filter(Boolean);

function projectMemberIds(project) {
  return [...new Set([idOf(project.owner), ...(project.members || []).map((member) => idOf(member.user))].filter(Boolean))];
}

// ---- tasks ----------------------------------------------------------------

function taskTarget(task) {
  return { id: task._id, project: task.project?._id || task.project };
}

const taskBase = (task, project, actor, extra = {}) => ({
  organization: task.organization,
  actor,
  target: taskTarget(task),
  resourceId: task._id,
  params: { task: task.title, project: project?.name, ...extra },
});

function taskAssignment({ task, project, actor, assigneeIds, previousAssigneeIds = [], occurrence }) {
  const next = ids(assigneeIds);
  const added = diff(next, previousAssigneeIds);
  const removed = diff(previousAssigneeIds, next);
  const stamp = occurrence ?? ms(task.updatedAt || task.createdAt);

  return safely('task assignment', async () => {
    if (added.length) {
      await notify({ type: 'task.assigned', recipients: added, occurrence: stamp, ...taskBase(task, project, actor) });
    }
    if (removed.length) {
      await notify({ type: 'task.unassigned', recipients: removed, occurrence: stamp, ...taskBase(task, project, actor) });
    }
  });
}

/** Only terminal transitions (and reopening) are worth interrupting people for. */
function taskStatusChanged({ task, project, actor, from, to }) {
  const terminal = [TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED];
  const reopened = terminal.includes(from) && !terminal.includes(to);
  if (!terminal.includes(to) && !reopened) return Promise.resolve(null);

  return safely('task status', () =>
    notify({
      type: 'task.status_changed',
      recipients: [idOf(task.owner), idOf(task.createdBy), ...ids(task.approvers), ...ids(task.assignees)],
      occurrence: `${ms(task.updatedAt)}:${to}`,
      ...taskBase(task, project, actor, { status: to }),
    }));
}

function taskSubmitted({ task, project, actor, submission }) {
  const reviewers = ids(task.approvers);
  return safely('task submitted', () =>
    notify({
      type: 'task.submitted',
      recipients: reviewers.length ? reviewers : [idOf(task.owner)],
      occurrence: idOf(submission),
      ...taskBase(task, project, actor),
    }));
}

function taskReviewed({ task, project, actor, review, submission }) {
  const type = {
    [TASK_REVIEW_ACTION.APPROVED]: 'task.approved',
    [TASK_REVIEW_ACTION.REJECTED]: 'task.rejected',
    [TASK_REVIEW_ACTION.CHANGES_REQUESTED]: 'task.changes_requested',
  }[review.action];
  if (!type) return Promise.resolve(null);

  return safely('task review', () =>
    notify({
      type,
      recipients: [...ids(task.assignees), idOf(submission?.submittedBy)],
      occurrence: idOf(review),
      ...taskBase(task, project, actor),
    }));
}

// ---- projects ---------------------------------------------------------------

const projectBase = (project, actor, extra = {}) => ({
  organization: project.organization,
  actor,
  target: { id: project._id },
  resourceId: project._id,
  params: { project: project.name, ...extra },
});

const projectMemberAdded = ({ project, actor, userId, role }) =>
  safely('project member added', () =>
    notify({ type: 'project.member_added', recipients: [userId], occurrence: ms(project.updatedAt), ...projectBase(project, actor, { role }) }));

const projectMemberRemoved = ({ project, actor, userId }) =>
  safely('project member removed', () =>
    notify({ type: 'project.member_removed', recipients: [userId], occurrence: ms(project.updatedAt), ...projectBase(project, actor) }));

const projectRoleChanged = ({ project, actor, userId, role }) =>
  safely('project role changed', () =>
    notify({ type: 'project.role_changed', recipients: [userId], occurrence: `${ms(project.updatedAt)}:${role}`, ...projectBase(project, actor, { role }) }));

const projectOwnershipTransferred = ({ project, actor, newOwnerId, previousOwnerId, newOwnerName }) =>
  safely('project ownership', async () => {
    const occurrence = ms(project.updatedAt);
    await notify({ type: 'project.ownership_received', recipients: [newOwnerId], occurrence, ...projectBase(project, actor) });
    await notify({
      type: 'project.ownership_removed',
      recipients: [previousOwnerId],
      occurrence,
      ...projectBase(project, actor, { newOwner: newOwnerName }),
    });
  });

const projectArchived = ({ project, actor }) =>
  safely('project archived', () =>
    notify({ type: 'project.archived', recipients: projectMemberIds(project), occurrence: ms(project.archivedAt), ...projectBase(project, actor) }));

const projectDeleted = ({ project, actor }) =>
  safely('project deleted', () =>
    notify({ type: 'project.deleted', recipients: projectMemberIds(project), occurrence: ms(project.deletedAt), ...projectBase(project, actor) }));

// ---- meetings ---------------------------------------------------------------

const meetingBase = (meeting, project, actor, extra = {}) => ({
  organization: meeting.organization,
  actor,
  target: { id: meeting._id, project: project?._id || meeting.project },
  resourceId: meeting._id,
  params: { topic: meeting.topic, project: project?.name, startTime: meeting.startTime, ...extra },
});

const activeParticipantIds = (meeting) =>
  (meeting.participants || [])
    .filter((entry) => entry.status !== MEETING_PARTICIPANT_STATUS.DECLINED)
    .map((entry) => idOf(entry.user));

const meetingInvited = ({ meeting, project, actor, userIds, occurrence }) =>
  safely('meeting invited', () =>
    notify({ type: 'meeting.invited', recipients: userIds, occurrence: occurrence ?? ms(meeting.updatedAt || meeting.createdAt), ...meetingBase(meeting, project, actor) }));

const meetingRemoved = ({ meeting, project, actor, userId }) =>
  safely('meeting removed', () =>
    notify({ type: 'meeting.removed', recipients: [userId], occurrence: ms(meeting.updatedAt), ...meetingBase(meeting, project, actor) }));

const MEANINGFUL_MEETING_FIELDS = ['topic', 'startTime', 'endTime'];
const meetingUpdated = ({ meeting, project, actor, changedFields }) => {
  if (!changedFields.some((field) => MEANINGFUL_MEETING_FIELDS.includes(field))) return Promise.resolve(null);
  return safely('meeting updated', () =>
    notify({ type: 'meeting.updated', recipients: activeParticipantIds(meeting), occurrence: ms(meeting.updatedAt), ...meetingBase(meeting, project, actor) }));
};

const meetingCancelled = ({ meeting, project, actor }) =>
  safely('meeting cancelled', () =>
    notify({ type: 'meeting.cancelled', recipients: activeParticipantIds(meeting), occurrence: ms(meeting.cancelledAt), ...meetingBase(meeting, project, actor) }));

const meetingRequestReceived = ({ request, project, actor }) =>
  safely('meeting request received', () => {
    // Who can act on a request: the project owner and Manager-role members.
    const deciders = [
      idOf(project.owner),
      ...(project.members || []).filter((m) => m.role === PROJECT_MEMBER_ROLES.MANAGER).map((m) => idOf(m.user)),
    ];
    return notify({
      type: 'meeting_request.received',
      organization: request.organization,
      recipients: deciders,
      actor,
      target: { id: request._id, project: project._id },
      resourceId: request._id,
      occurrence: 'created',
      params: { topic: request.topic },
    });
  });

const meetingRequestDecided = ({ request, project, actor, status, remarks }) =>
  safely('meeting request decision', () =>
    notify({
      type: status === 'Rejected' ? 'meeting_request.rejected' : 'meeting_request.approved',
      organization: request.organization,
      recipients: [request.requestedBy],
      actor,
      target: { id: request._id, project: project?._id || request.project },
      resourceId: request._id,
      occurrence: `decided:${ms(request.decidedAt)}`,
      params: { topic: request.topic, status, remarks: remarks || '' },
    }));

/** Called by the reminder job; idempotent per (meeting, start time). */
function meetingReminder({ meeting, project, now = Date.now() }) {
  const minutes = Math.max(1, Math.round((new Date(meeting.startTime).getTime() - now) / 60000));
  return safely('meeting reminder', () =>
    notify({
      type: 'meeting.reminder',
      recipients: activeParticipantIds(meeting),
      occurrence: `T-${REMINDER_LEAD_MS / 60000}:${ms(meeting.startTime)}`,
      ...meetingBase(meeting, project, null, { minutes }),
    }));
}

// ---- people & teams -----------------------------------------------------------

const teamBase = (team, actor, extra = {}) => ({
  organization: team.organization,
  actor,
  target: { id: team._id },
  resourceId: team._id,
  params: { team: team.name, ...extra },
});

const teamMemberAdded = ({ team, actor, userId }) =>
  safely('team member added', () =>
    notify({ type: 'team.member_added', recipients: [userId], occurrence: ms(team.updatedAt), ...teamBase(team, actor) }));

const teamMemberRemoved = ({ team, actor, userId }) =>
  safely('team member removed', () =>
    notify({ type: 'team.member_removed', recipients: [userId], occurrence: ms(team.updatedAt), ...teamBase(team, actor) }));

const teamManagerChanged = ({ team, actor, newManagerId, previousManagerId }) =>
  safely('team manager changed', async () => {
    const occurrence = ms(team.updatedAt);
    await notify({ type: 'team.manager_assigned', recipients: [newManagerId], occurrence, ...teamBase(team, actor) });
    if (previousManagerId) {
      await notify({ type: 'team.manager_removed', recipients: [previousManagerId], occurrence, ...teamBase(team, actor) });
    }
  });

const personRoleChanged = ({ person, actor, role }) =>
  safely('role changed', () =>
    notify({
      type: 'person.role_changed',
      organization: person.organization,
      recipients: [person._id],
      actor,
      resourceId: person._id,
      occurrence: `${ms(person.updatedAt)}:${role}`,
      params: { role },
    }));

const personAccessRestored = ({ person, actor }) =>
  safely('access restored', () =>
    notify({
      type: 'security.access_restored',
      organization: person.organization,
      recipients: [person._id],
      actor,
      resourceId: person._id,
      occurrence: ms(person.updatedAt),
    }));

const personPasswordResetForced = ({ person, actor }) =>
  safely('password reset forced', () =>
    notify({
      type: 'security.password_reset_forced',
      organization: person.organization,
      recipients: [person._id],
      actor,
      resourceId: person._id,
      occurrence: Date.now(),
    }));

/** Blocked / removed people get an email only — they can't open the app. */
async function accountEmail({ type, person, organizationId, occurrence }) {
  return safely(type, async () => {
    const organization = await Organization.findById(organizationId).select('name').lean();
    return sendAccountEmail({ type, user: person, organizationName: organization?.name, organizationId, occurrence });
  });
}

const personAccessBlocked = ({ person, organizationId }) =>
  accountEmail({ type: 'security.access_blocked', person, organizationId, occurrence: ms(person.orgBlockedAt) });

const personRemovedFromOrganization = ({ person, organizationId }) =>
  accountEmail({ type: 'security.removed_from_org', person, organizationId, occurrence: ms(person.updatedAt) });

// ---- calendar -----------------------------------------------------------------

const calendarBase = (event, actor, extra = {}) => ({
  organization: event.organization,
  actor,
  target: { id: event._id },
  resourceId: event._id,
  params: { event: event.title, ...extra },
});

const calendarInvited = ({ event, actor, userIds, occurrence }) =>
  safely('calendar invited', () =>
    notify({ type: 'calendar.event_invited', recipients: userIds, occurrence: occurrence ?? ms(event.updatedAt || event.createdAt), ...calendarBase(event, actor) }));

const calendarUpdated = ({ event, actor, userIds, occurrence }) =>
  safely('calendar updated', () =>
    notify({ type: 'calendar.event_updated', recipients: userIds, occurrence: occurrence ?? ms(event.updatedAt), ...calendarBase(event, actor) }));

const calendarCancelled = ({ event, actor, userIds, occurrence, occurrenceOnly = false }) =>
  safely('calendar cancelled', () =>
    notify({
      type: 'calendar.event_cancelled',
      recipients: userIds,
      occurrence: occurrence ?? `cancelled:${ms(event.deletedAt)}`,
      ...calendarBase(event, actor, occurrenceOnly ? { occurrence: true } : {}),
    }));

/** One notification per (event occurrence, reminder offset); `anchor` is the occurrence's start instant. */
const calendarReminder = ({ event, userIds, anchor, minutes, when, emailRequested }) =>
  safely('calendar reminder', () =>
    notify({
      type: 'calendar.reminder',
      recipients: userIds,
      occurrence: `${anchor}:${minutes}`,
      emailRequested,
      ...calendarBase(event, null, { when }),
    }));

// ---- documents ----------------------------------------------------------------

const documentBase = (document, actor, extra = {}) => ({
  organization: document.organization,
  actor,
  target: { id: document._id },
  resourceId: document._id,
  params: { document: document.name, ...extra },
});

const documentShared = ({ document, actor, userId, permission, sharedAt }) =>
  safely('document shared', () =>
    notify({ type: 'document.shared', recipients: [userId], occurrence: ms(sharedAt), ...documentBase(document, actor, { permission }) }));

const documentAccessRevoked = ({ document, actor, userId }) =>
  safely('document access revoked', () =>
    notify({ type: 'document.access_revoked', recipients: [userId], occurrence: ms(document.updatedAt), ...documentBase(document, actor) }));

/** Owner + people the document was explicitly shared with (not every possible viewer). */
const documentVersionUploaded = ({ document, actor, version, restored = false }) =>
  safely('document version', () =>
    notify({
      type: 'document.version_uploaded',
      recipients: [idOf(document.owner), ...(document.sharedWith || []).map((share) => idOf(share.user))],
      occurrence: `v${version}`,
      ...documentBase(document, actor, { restored, version }),
    }));

module.exports = {
  calendarCancelled,
  calendarInvited,
  calendarReminder,
  calendarUpdated,
  documentAccessRevoked,
  documentShared,
  documentVersionUploaded,
  meetingCancelled,
  meetingInvited,
  meetingReminder,
  meetingRemoved,
  meetingRequestDecided,
  meetingRequestReceived,
  meetingUpdated,
  personAccessBlocked,
  personAccessRestored,
  personPasswordResetForced,
  personRemovedFromOrganization,
  personRoleChanged,
  projectArchived,
  projectDeleted,
  projectMemberAdded,
  projectMemberRemoved,
  projectOwnershipTransferred,
  projectRoleChanged,
  taskAssignment,
  taskReviewed,
  taskStatusChanged,
  taskSubmitted,
  teamManagerChanged,
  teamMemberAdded,
  teamMemberRemoved,
};
