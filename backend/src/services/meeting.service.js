const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const env = require('../config/env');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const {
  MEETING_TYPE,
  MEETING_STATUS,
  MEETING_ROOM_STATUS,
  MEETING_PARTICIPANT_ROLE,
  MEETING_PARTICIPANT_STATUS,
} = require('../constants/meeting.constants');
const { canViewProject, getProjectMemberRole } = require('../utils/projectAccess');
const { canJoinMeeting, canManageMeeting, canScheduleMeeting, canViewMeeting } = require('../utils/meetingAccess');
const { findActiveProject } = require('./project.service');
const { logAudit } = require('./audit.service');
const notificationEvents = require('./notificationEvents');
const livekitService = require('./livekit.service');
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function populateMeeting(meeting) {
  await meeting.populate([
    { path: 'host', select: 'firstName lastName email' },
    { path: 'participants.user', select: 'firstName lastName email' },
    { path: 'project', select: 'name' },
  ]);
  return meeting;
}

async function findActiveMeeting(meetingId, organization) {
  if (!mongoose.isValidObjectId(meetingId)) {
    throw new AppError('Meeting not found', 404, 'NOT_FOUND');
  }

  const meeting = await Meeting.findOne({ _id: meetingId, organization, deletedAt: null });
  if (!meeting) {
    throw new AppError('Meeting not found', 404, 'NOT_FOUND');
  }

  return meeting;
}

function assertCanView(actor, project, meeting) {
  if (!canViewMeeting(actor, project, meeting)) {
    throw new AppError('You do not have access to this meeting', 403, 'FORBIDDEN');
  }
}

function assertCanManage(actor, project, meeting) {
  if (!canManageMeeting(actor, project, meeting)) {
    throw new AppError('You do not have permission to manage this meeting', 403, 'FORBIDDEN');
  }
}

async function assertUsersInProject(userIds, project, label) {
  if (!userIds || userIds.length === 0) return;

  const uniqueIds = [...new Set(userIds.map((id) => id.toString()))];

  const users = await User.find({ _id: { $in: uniqueIds }, organization: project.organization }).select('_id');
  if (users.length !== uniqueIds.length) {
    throw new AppError(`One or more ${label} could not be found in this organization`, 404, 'NOT_FOUND');
  }

  const notInProject = uniqueIds.filter((id) => !getProjectMemberRole(project, id));
  if (notInProject.length > 0) {
    throw new AppError(`${label} must be members of the project`, 400, 'NOT_PROJECT_MEMBER');
  }
}

function buildParticipants(userIds, hostId) {
  const uniqueIds = [...new Set((userIds || []).map((id) => id.toString()))].filter((id) => id !== hostId.toString());

  const entries = [
    {
      user: hostId,
      role: MEETING_PARTICIPANT_ROLE.HOST,
      status: MEETING_PARTICIPANT_STATUS.ACCEPTED,
      invitedAt: new Date(),
      respondedAt: new Date(),
    },
  ];

  uniqueIds.forEach((id) => {
    entries.push({
      user: id,
      role: MEETING_PARTICIPANT_ROLE.PARTICIPANT,
      status: MEETING_PARTICIPANT_STATUS.INVITED,
      invitedAt: new Date(),
    });
  });

  return entries;
}

// Every project member (owner + all member roles) is automatically a
// meeting participant — a meeting created inside a project is visible/
// joinable by the whole project, not just whoever the scheduler happened to
// tick in a picker. Explicit `participants` passed by the creator are still
// merged in defensively but no longer the source of truth.
function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function getAllProjectMemberIds(project) {
  const ids = new Set();
  if (project.owner) ids.add(idOf(project.owner));
  (project.members || []).forEach((entry) => ids.add(idOf(entry.user)));
  return [...ids].filter(Boolean);
}

// Invitations now flow through the notification system: an in-app
// notification for everyone, plus the same invitation email for people whose
// preferences allow it (so email delivery is deduplicated and retried by
// the hardened email queue instead of fire-and-forget).
async function notifyParticipants(meeting, project, userIds, actor) {
  if (!userIds || userIds.length === 0) return;
  await notificationEvents.meetingInvited({ meeting, project, actor, userIds });
}

async function createMeeting({ type, projectId, topic, description, participants, startTime, endTime, sourceRequest, creator, req }) {
  const project = await findActiveProject(projectId, creator.organization);

  if (!canScheduleMeeting(creator, project)) {
    throw new AppError('You do not have permission to schedule meetings for this project', 403, 'FORBIDDEN');
  }

  if (participants?.length) {
    await assertUsersInProject(participants, project, 'Participants');
  }

  const allMemberIds = getAllProjectMemberIds(project);
  const invitedIds = [...new Set([...allMemberIds, ...(participants || [])])];

  const meeting = await Meeting.create({
    organization: creator.organization,
    project: project._id,
    topic: topic.trim(),
    description: description || '',
    type,
    status: type === MEETING_TYPE.INSTANT ? MEETING_STATUS.ACTIVE : MEETING_STATUS.SCHEDULED,
    startTime,
    endTime: endTime || null,
    host: creator._id,
    participants: buildParticipants(invitedIds, creator._id),
    sourceRequest: sourceRequest || null,
    createdBy: creator._id,
    updatedBy: creator._id,
  });

  await logAudit({
    action: AUDIT_EVENTS.MEETING_CREATED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { topic: meeting.topic, project: project._id.toString(), type },
    organizationId: creator.organization,
    req,
    userId: creator._id,
  });

  const hostId = creator._id.toString();
  await notifyParticipants(meeting, project, invitedIds.filter((id) => id !== hostId), creator);
  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function createScheduledMeeting({ projectId, topic, description, participants, startTime, endTime, sourceRequest, creator, req }) {
  return createMeeting({
    type: MEETING_TYPE.SCHEDULED,
    projectId,
    topic,
    description,
    participants,
    startTime,
    endTime,
    sourceRequest,
    creator,
    req,
  });
}

async function createInstantMeeting({ projectId, topic, description, participants, creator, req }) {
  return createMeeting({
    type: MEETING_TYPE.INSTANT,
    projectId,
    topic,
    description,
    participants,
    startTime: new Date(),
    endTime: null,
    creator,
    req,
  });
}

async function getMeeting({ meetingId, actor }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanView(actor, project, meeting);

  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function listMeetings({
  projectId,
  actor,
  search,
  status,
  sortBy = 'startTime',
  sortOrder = 'asc',
  page = 1,
  limit = 20,
}) {
  const project = await findActiveProject(projectId, actor.organization);
  if (!canViewProject(actor, project)) {
    throw new AppError('You do not have access to this project', 403, 'FORBIDDEN');
  }

  const conditions = [{ organization: actor.organization }, { project: project._id }, { deletedAt: null }];

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    conditions.push({ $or: [{ topic: regex }, { description: regex }] });
  }

  if (status) conditions.push({ status });

  const query = { $and: conditions };
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [meetings, total] = await Promise.all([
    Meeting.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('host', 'firstName lastName email')
      .populate('participants.user', 'firstName lastName email'),
    Meeting.countDocuments(query),
  ]);

  return {
    meetings: meetings.map((meeting) => meeting.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function listMyMeetings({ actor, search, status, sortBy = 'startTime', sortOrder = 'asc', page = 1, limit = 20 }) {
  const conditions = [
    { organization: actor.organization },
    { deletedAt: null },
    { $or: [{ host: actor._id }, { 'participants.user': actor._id }] },
  ];

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    conditions.push({ $or: [{ topic: regex }, { description: regex }] });
  }

  if (status) conditions.push({ status });

  const query = { $and: conditions };
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [meetings, total] = await Promise.all([
    Meeting.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('host', 'firstName lastName email')
      .populate('participants.user', 'firstName lastName email')
      .populate('project', 'name'),
    Meeting.countDocuments(query),
  ]);

  return {
    meetings: meetings.map((meeting) => meeting.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function updateMeeting({ meetingId, actor, updates, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  if (meeting.status === MEETING_STATUS.CANCELLED || meeting.status === MEETING_STATUS.ENDED) {
    throw new AppError('This meeting has already finished and cannot be edited', 400, 'MEETING_FINISHED');
  }

  // The route-level schema only checks startTime/endTime against each other
  // when BOTH are present in the same request — it can't see the meeting's
  // existing values. Re-check against the merged result here so editing
  // just one of the two can't leave endTime before startTime.
  const nextStartTime = updates.startTime !== undefined ? updates.startTime : meeting.startTime;
  const nextEndTime = updates.endTime !== undefined ? updates.endTime : meeting.endTime;
  if (nextEndTime && nextStartTime && nextEndTime <= nextStartTime) {
    throw new AppError('End time must be after the start time', 400, 'INVALID_TIME_RANGE');
  }

  Object.assign(meeting, updates);
  meeting.updatedBy = actor._id;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_UPDATED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { fields: Object.keys(updates) },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.meetingUpdated({ meeting, project, actor, changedFields: Object.keys(updates) });

  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function cancelMeeting({ meetingId, actor, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  if (meeting.status !== MEETING_STATUS.SCHEDULED) {
    throw new AppError('Only a Scheduled meeting can be cancelled', 400, 'INVALID_STATUS_TRANSITION');
  }

  meeting.status = MEETING_STATUS.CANCELLED;
  meeting.cancelledAt = new Date();
  meeting.cancelledBy = actor._id;
  meeting.updatedBy = actor._id;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_CANCELLED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { topic: meeting.topic },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.meetingCancelled({ meeting, project, actor });

  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function addParticipants({ meetingId, actor, participants, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  await assertUsersInProject(participants, project, 'Participants');

  const existingIds = new Set(meeting.participants.map((entry) => entry.user.toString()));
  const newIds = participants.filter((id) => !existingIds.has(id.toString()));

  newIds.forEach((id) => {
    meeting.participants.push({
      user: id,
      role: MEETING_PARTICIPANT_ROLE.PARTICIPANT,
      status: MEETING_PARTICIPANT_STATUS.INVITED,
      invitedAt: new Date(),
    });
  });

  meeting.updatedBy = actor._id;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_PARTICIPANT_ADDED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { added: newIds },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notifyParticipants(meeting, project, newIds, actor);
  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function removeParticipant({ meetingId, userId, actor, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  if (meeting.host.toString() === userId) {
    throw new AppError('The host cannot be removed from the meeting', 400, 'CANNOT_REMOVE_HOST');
  }

  const before = meeting.participants.length;
  meeting.participants = meeting.participants.filter((entry) => entry.user.toString() !== userId);

  if (meeting.participants.length === before) {
    throw new AppError('This user is not a participant of the meeting', 404, 'PARTICIPANT_NOT_FOUND');
  }

  meeting.updatedBy = actor._id;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_PARTICIPANT_REMOVED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { userId },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.meetingRemoved({ meeting, project, actor, userId });

  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

/**
 * Disconnects someone from the *live* call without touching their invite
 * record — distinct from removeParticipant above, which uninvites them for
 * next time but leaves them connected right now if the meeting is ongoing.
 */
async function kickParticipant({ meetingId, userId, actor, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  if (meeting.host.toString() === userId) {
    throw new AppError('The host cannot be removed from the call', 400, 'CANNOT_REMOVE_HOST');
  }

  if (actor._id.toString() === userId) {
    throw new AppError("You can't remove yourself from the call", 400, 'CANNOT_REMOVE_SELF');
  }

  if (meeting.status !== MEETING_STATUS.ACTIVE || !meeting.livekitRoomName) {
    throw new AppError('This meeting is not currently live', 400, 'MEETING_NOT_LIVE');
  }

  await livekitService.removeParticipantFromRoom(meeting.livekitRoomName, userId);

  await logAudit({
    action: AUDIT_EVENTS.MEETING_PARTICIPANT_KICKED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { userId },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { success: true };
}

async function getJoinToken({ meetingId, actor, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);

  if (!canJoinMeeting(actor, project, meeting)) {
    throw new AppError('You do not have permission to join this meeting', 403, 'FORBIDDEN');
  }

  if (meeting.status === MEETING_STATUS.CANCELLED || meeting.status === MEETING_STATUS.ENDED) {
    throw new AppError('This meeting is not currently live', 400, 'MEETING_NOT_LIVE');
  }

  const isFirstJoin = meeting.roomStatus === MEETING_ROOM_STATUS.NONE;
  if (isFirstJoin) {
    meeting.livekitRoomName = `mtg-${meeting._id.toString()}`;
    await livekitService.ensureRoom(meeting.livekitRoomName);
    meeting.roomStatus = MEETING_ROOM_STATUS.CREATED;
    meeting.status = MEETING_STATUS.ACTIVE;
  }

  const participant = meeting.participants.find((entry) => entry.user.toString() === actor._id.toString());
  if (participant) {
    participant.joinedAt = new Date();
    participant.status = MEETING_PARTICIPANT_STATUS.ACCEPTED;
    participant.respondedAt = participant.respondedAt || new Date();
  } else {
    // Manager/admin dropping in without being explicitly invited (allowed
    // by canJoinMeeting) — record their attendance as a participant too.
    meeting.participants.push({
      user: actor._id,
      role: MEETING_PARTICIPANT_ROLE.PARTICIPANT,
      status: MEETING_PARTICIPANT_STATUS.ACCEPTED,
      invitedAt: new Date(),
      respondedAt: new Date(),
      joinedAt: new Date(),
    });
  }

  meeting.updatedBy = actor._id;
  await meeting.save();

  const token = await livekitService.generateJoinToken({
    roomName: meeting.livekitRoomName,
    identity: actor._id.toString(),
    name: `${actor.firstName} ${actor.lastName}`.trim(),
    canPublish: true,
  });

  await logAudit({
    action: isFirstJoin ? AUDIT_EVENTS.MEETING_STARTED : AUDIT_EVENTS.MEETING_JOINED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { userId: actor._id.toString() },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  return { token, url: env.LIVEKIT_URL, roomName: meeting.livekitRoomName };
}

async function endMeetingForEveryone({ meetingId, actor, req }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanManage(actor, project, meeting);

  if (meeting.status !== MEETING_STATUS.ACTIVE) {
    throw new AppError('Only an Active meeting can be ended', 400, 'INVALID_STATUS_TRANSITION');
  }

  if (meeting.livekitRoomName) {
    // Best-effort: if LiveKit is unreachable/misconfigured, don't let that
    // strand the meeting stuck "Active" forever in our own DB — the room
    // will also self-close on its own emptyTimeout either way.
    await livekitService.endRoom(meeting.livekitRoomName).catch((error) => {
      console.error(`Failed to end LiveKit room ${meeting.livekitRoomName}:`, error.message);
    });
  }

  meeting.status = MEETING_STATUS.ENDED;
  meeting.roomStatus = MEETING_ROOM_STATUS.ENDED;
  meeting.endTime = meeting.endTime || new Date();
  meeting.updatedBy = actor._id;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_ENDED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { topic: meeting.topic },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await populateMeeting(meeting);
  return meeting.toSafeObject();
}

async function listMeetingActivity({ meetingId, actor, page = 1, limit = 20 }) {
  const meeting = await findActiveMeeting(meetingId, actor.organization);
  const project = await findActiveProject(meeting.project, actor.organization);
  assertCanView(actor, project, meeting);

  const query = { organization: actor.organization, entityType: 'meeting', entityId: meeting._id.toString() };
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email'),
    AuditLog.countDocuments(query),
  ]);

  return {
    activity: logs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

/**
 * Authoritative room-lifecycle sync driven by LiveKit webhooks (when
 * LIVEKIT_WEBHOOK_ENABLED) — reconciles what `getJoinToken` recorded
 * optimistically with what actually happened on the LiveKit server side.
 * Unknown room names (e.g. a room from a deleted meeting) are ignored.
 */
async function syncFromWebhookEvent(event) {
  const roomName = event?.room?.name;
  if (!roomName) return;

  const meeting = await Meeting.findOne({ livekitRoomName: roomName, deletedAt: null });
  if (!meeting) return;

  if (event.event === 'room_finished') {
    if (meeting.status !== MEETING_STATUS.ENDED) {
      meeting.status = MEETING_STATUS.ENDED;
      meeting.roomStatus = MEETING_ROOM_STATUS.ENDED;
      meeting.endTime = meeting.endTime || new Date();
      await meeting.save();

      await logAudit({
        action: AUDIT_EVENTS.MEETING_ENDED,
        entityId: meeting._id.toString(),
        entityType: 'meeting',
        metadata: { via: 'webhook', topic: meeting.topic },
        organizationId: meeting.organization,
      });
    }
    return;
  }

  const identity = event?.participant?.identity;
  if (!identity) return;

  const participant = meeting.participants.find((entry) => entry.user.toString() === identity);
  if (!participant) return;

  if (event.event === 'participant_left') {
    participant.leftAt = new Date();
    await meeting.save();
  } else if (event.event === 'participant_joined') {
    participant.joinedAt = new Date();
    await meeting.save();
  }
}

const EMPTY_ROOM_GRACE_MS = 10 * 60 * 1000;
const UNSTARTED_MEETING_GRACE_MS = 30 * 60 * 1000;

async function autoEndEmptyMeeting(meeting) {
  if (meeting.livekitRoomName) {
    // Best-effort, same reasoning as endMeetingForEveryone — the room may
    // already be gone via LiveKit's own emptyTimeout.
    await livekitService.endRoom(meeting.livekitRoomName).catch((error) => {
      console.error(`Auto-cleanup: failed to end LiveKit room ${meeting.livekitRoomName}:`, error.message);
    });
  }

  meeting.status = MEETING_STATUS.ENDED;
  meeting.roomStatus = MEETING_ROOM_STATUS.ENDED;
  meeting.endTime = meeting.endTime || new Date();
  meeting.roomEmptyDetectedAt = null;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_ENDED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { topic: meeting.topic, via: 'auto-cleanup-empty-room' },
    organizationId: meeting.organization,
  });
}

async function autoCancelUnstartedMeeting(meeting) {
  meeting.status = MEETING_STATUS.CANCELLED;
  meeting.cancelledAt = new Date();
  meeting.cancelledBy = null;
  await meeting.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_CANCELLED,
    entityId: meeting._id.toString(),
    entityType: 'meeting',
    metadata: { topic: meeting.topic, via: 'auto-cleanup-unstarted' },
    organizationId: meeting.organization,
  });
}

// Rule 1: an Active meeting whose room has sat with zero live participants
// for EMPTY_ROOM_GRACE_MS gets ended. `roomEmptyDetectedAt` remembers when
// the room first looked empty across sweep runs, and is cleared the moment
// someone is present so a brief drop/rejoin doesn't get counted.
async function sweepEmptyActiveMeetings() {
  const meetings = await Meeting.find({
    status: MEETING_STATUS.ACTIVE,
    roomStatus: MEETING_ROOM_STATUS.CREATED,
    deletedAt: null,
  });

  for (const meeting of meetings) {
    let participants;
    try {
      participants = await livekitService.listParticipants(meeting.livekitRoomName);
    } catch (error) {
      console.error(`Auto-cleanup: failed to list participants for ${meeting.livekitRoomName}:`, error.message);
      continue;
    }

    if (participants.length > 0) {
      if (meeting.roomEmptyDetectedAt) {
        meeting.roomEmptyDetectedAt = null;
        await meeting.save();
      }
      continue;
    }

    if (!meeting.roomEmptyDetectedAt) {
      meeting.roomEmptyDetectedAt = new Date();
      await meeting.save();
      continue;
    }

    if (Date.now() - meeting.roomEmptyDetectedAt.getTime() >= EMPTY_ROOM_GRACE_MS) {
      await autoEndEmptyMeeting(meeting);
    }
  }
}

// Rule 2: a Scheduled meeting nobody has ever joined (roomStatus still
// `none`) gets cancelled once UNSTARTED_MEETING_GRACE_MS has passed since
// its startTime, so no-shows don't linger in "Scheduled" forever.
async function sweepUnstartedScheduledMeetings() {
  const cutoff = new Date(Date.now() - UNSTARTED_MEETING_GRACE_MS);
  const meetings = await Meeting.find({
    status: MEETING_STATUS.SCHEDULED,
    roomStatus: MEETING_ROOM_STATUS.NONE,
    startTime: { $lte: cutoff },
    deletedAt: null,
  });

  for (const meeting of meetings) {
    await autoCancelUnstartedMeeting(meeting);
  }
}

async function runMeetingAutoCleanup() {
  await sweepEmptyActiveMeetings().catch((error) => console.error('Auto-cleanup (empty rooms) failed:', error));
  await sweepUnstartedScheduledMeetings().catch((error) => console.error('Auto-cleanup (unstarted meetings) failed:', error));
}

module.exports = {
  addParticipants,
  cancelMeeting,
  createInstantMeeting,
  createScheduledMeeting,
  endMeetingForEveryone,
  findActiveMeeting,
  getJoinToken,
  getMeeting,
  kickParticipant,
  listMeetingActivity,
  listMeetings,
  listMyMeetings,
  removeParticipant,
  runMeetingAutoCleanup,
  syncFromWebhookEvent,
  updateMeeting,
};
