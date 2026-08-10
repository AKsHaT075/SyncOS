const MEETING_TYPE = Object.freeze({
  SCHEDULED: 'Scheduled',
  INSTANT: 'Instant',
});

const MEETING_STATUS = Object.freeze({
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  ENDED: 'Ended',
  CANCELLED: 'Cancelled',
});

const MEETING_PARTICIPANT_ROLE = Object.freeze({
  HOST: 'Host',
  PARTICIPANT: 'Participant',
});

const MEETING_PARTICIPANT_STATUS = Object.freeze({
  INVITED: 'Invited',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
});

const MEETING_ROOM_STATUS = Object.freeze({
  NONE: 'none',
  CREATED: 'created',
  ENDED: 'ended',
});

const MEETING_REQUEST_STATUS = Object.freeze({
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SCHEDULED: 'Scheduled',
});

module.exports = {
  MEETING_TYPE,
  MEETING_STATUS,
  MEETING_PARTICIPANT_ROLE,
  MEETING_PARTICIPANT_STATUS,
  MEETING_ROOM_STATUS,
  MEETING_REQUEST_STATUS,
};
