const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { MEETING_REQUEST_STATUS } = require('../constants/meeting.constants');
const { canRequestMeeting, canScheduleMeeting } = require('../utils/meetingAccess');
const { getProjectMemberRole } = require('../utils/projectAccess');
const { findActiveProject } = require('./project.service');
const { createScheduledMeeting } = require('./meeting.service');
const { logAudit } = require('./audit.service');
const notificationEvents = require('./notificationEvents');
const MeetingRequest = require('../models/MeetingRequest');
const User = require('../models/User');

async function populateRequest(request) {
  await request.populate([
    { path: 'requestedBy', select: 'firstName lastName email' },
    { path: 'requestedMembers', select: 'firstName lastName email' },
  ]);
  return request;
}

async function findActiveMeetingRequest(requestId, organization) {
  if (!mongoose.isValidObjectId(requestId)) {
    throw new AppError('Meeting request not found', 404, 'NOT_FOUND');
  }

  const request = await MeetingRequest.findOne({ _id: requestId, organization });
  if (!request) {
    throw new AppError('Meeting request not found', 404, 'NOT_FOUND');
  }

  return request;
}

async function createMeetingRequest({ projectId, topic, reason, requestedMembers, preferredDate, preferredTime, actor, req }) {
  const project = await findActiveProject(projectId, actor.organization);

  if (!canRequestMeeting(actor, project)) {
    throw new AppError('You do not have permission to request a meeting for this project', 403, 'FORBIDDEN');
  }

  if (requestedMembers?.length) {
    const uniqueIds = [...new Set(requestedMembers.map((id) => id.toString()))];
    const users = await User.find({ _id: { $in: uniqueIds }, organization: actor.organization }).select('_id');
    if (users.length !== uniqueIds.length) {
      throw new AppError('One or more requested members could not be found in this organization', 404, 'NOT_FOUND');
    }
    const notInProject = uniqueIds.filter((id) => !getProjectMemberRole(project, id));
    if (notInProject.length > 0) {
      throw new AppError('Requested members must be members of the project', 400, 'NOT_PROJECT_MEMBER');
    }
  }

  const request = await MeetingRequest.create({
    organization: actor.organization,
    project: project._id,
    requestedBy: actor._id,
    topic: topic.trim(),
    reason: reason.trim(),
    requestedMembers: requestedMembers || [],
    preferredDate: preferredDate || null,
    preferredTime: preferredTime || '',
    status: MEETING_REQUEST_STATUS.PENDING,
  });

  await logAudit({
    action: AUDIT_EVENTS.MEETING_REQUEST_CREATED,
    entityId: request._id.toString(),
    entityType: 'meeting_request',
    metadata: { topic: request.topic, project: project._id.toString() },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notificationEvents.meetingRequestReceived({ request, project, actor });

  await populateRequest(request);
  return request.toSafeObject();
}

async function listMeetingRequests({ projectId, actor, status, page = 1, limit = 20 }) {
  const project = await findActiveProject(projectId, actor.organization);

  const conditions = [{ organization: actor.organization }, { project: project._id }];

  // Managers/schedulers see every request for the project; everyone else
  // (the population that can only request, not schedule) sees just their own.
  if (!canScheduleMeeting(actor, project)) {
    conditions.push({ requestedBy: actor._id });
  }

  if (status) conditions.push({ status });

  const query = { $and: conditions };
  const skip = (page - 1) * limit;

  const [requests, total] = await Promise.all([
    MeetingRequest.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('requestedBy', 'firstName lastName email')
      .populate('requestedMembers', 'firstName lastName email'),
    MeetingRequest.countDocuments(query),
  ]);

  return {
    requests: requests.map((request) => request.toSafeObject()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

async function assertPendingAndSchedulable(request, actor) {
  const project = await findActiveProject(request.project, actor.organization);

  if (!canScheduleMeeting(actor, project)) {
    throw new AppError('You do not have permission to decide on this meeting request', 403, 'FORBIDDEN');
  }

  if (request.status !== MEETING_REQUEST_STATUS.PENDING) {
    throw new AppError('This request has already been decided', 400, 'INVALID_STATUS_TRANSITION');
  }

  return project;
}

async function approveMeetingRequest({ requestId, actor, remarks, req }) {
  const request = await findActiveMeetingRequest(requestId, actor.organization);
  const project = await assertPendingAndSchedulable(request, actor);

  // A request can sit Pending for days — if the requester's preferredDate
  // has since slipped into the past, fall back to "an hour from now" rather
  // than silently scheduling a meeting that already happened.
  const preferredIsFuture = request.preferredDate && request.preferredDate.getTime() > Date.now();
  const startTime = preferredIsFuture ? request.preferredDate : new Date(Date.now() + 60 * 60 * 1000);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  const meeting = await createScheduledMeeting({
    projectId: request.project,
    topic: request.topic,
    description: request.reason,
    participants: request.requestedMembers.map((id) => id.toString()),
    startTime,
    endTime,
    sourceRequest: request._id,
    creator: actor,
    req,
  });

  request.status = MEETING_REQUEST_STATUS.APPROVED;
  request.decidedBy = actor._id;
  request.decidedAt = new Date();
  request.decisionRemarks = remarks || '';
  request.resultingMeeting = meeting.id;
  await request.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_REQUEST_APPROVED,
    entityId: request._id.toString(),
    entityType: 'meeting_request',
    metadata: { resultingMeeting: meeting.id },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notifyRequester({ request, project, actor, status: MEETING_REQUEST_STATUS.APPROVED, remarks });
  await populateRequest(request);
  return request.toSafeObject();
}

async function scheduleMeetingRequest({ requestId, actor, remarks, startTime, endTime, req }) {
  const request = await findActiveMeetingRequest(requestId, actor.organization);
  const project = await assertPendingAndSchedulable(request, actor);

  const meeting = await createScheduledMeeting({
    projectId: request.project,
    topic: request.topic,
    description: request.reason,
    participants: request.requestedMembers.map((id) => id.toString()),
    startTime,
    endTime,
    sourceRequest: request._id,
    creator: actor,
    req,
  });

  request.status = MEETING_REQUEST_STATUS.SCHEDULED;
  request.decidedBy = actor._id;
  request.decidedAt = new Date();
  request.decisionRemarks = remarks || '';
  request.resultingMeeting = meeting.id;
  await request.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_REQUEST_SCHEDULED,
    entityId: request._id.toString(),
    entityType: 'meeting_request',
    metadata: { resultingMeeting: meeting.id },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notifyRequester({ request, project, actor, status: MEETING_REQUEST_STATUS.SCHEDULED, remarks });
  await populateRequest(request);
  return request.toSafeObject();
}

async function rejectMeetingRequest({ requestId, actor, remarks, req }) {
  const request = await findActiveMeetingRequest(requestId, actor.organization);
  const project = await assertPendingAndSchedulable(request, actor);

  request.status = MEETING_REQUEST_STATUS.REJECTED;
  request.decidedBy = actor._id;
  request.decidedAt = new Date();
  request.decisionRemarks = remarks || '';
  await request.save();

  await logAudit({
    action: AUDIT_EVENTS.MEETING_REQUEST_REJECTED,
    entityId: request._id.toString(),
    entityType: 'meeting_request',
    metadata: { remarks },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });

  await notifyRequester({ request, project, actor, status: MEETING_REQUEST_STATUS.REJECTED, remarks });
  await populateRequest(request);
  return request.toSafeObject();
}

// The decision reaches the requester as an in-app notification and — per
// their preferences — the same decision email as before, via the email queue.
async function notifyRequester({ request, project, actor, status, remarks }) {
  await notificationEvents.meetingRequestDecided({ request, project, actor, status, remarks });
}

module.exports = {
  approveMeetingRequest,
  createMeetingRequest,
  listMeetingRequests,
  rejectMeetingRequest,
  scheduleMeetingRequest,
};
