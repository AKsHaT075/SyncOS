const mongoose = require('mongoose');
const { MEETING_REQUEST_STATUS } = require('../constants/meeting.constants');

const meetingRequestSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    requestedMembers: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    preferredDate: {
      type: Date,
      default: null,
    },
    preferredTime: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(MEETING_REQUEST_STATUS),
      default: MEETING_REQUEST_STATUS.PENDING,
      index: true,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    decisionRemarks: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * Set once the request is approved/scheduled — the resulting Meeting is
     * a normal Meeting document, this is just the back-reference so the
     * requester's UI can jump straight to it.
     */
    resultingMeeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Meeting',
      default: null,
    },
  },
  { timestamps: true }
);

meetingRequestSchema.index({ organization: 1, project: 1, status: 1 });

function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function summarizeUser(value) {
  if (!value) return null;
  if (value.firstName) {
    return { id: value._id.toString(), fullName: `${value.firstName} ${value.lastName}`.trim(), email: value.email };
  }
  return { id: value.toString() };
}

meetingRequestSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    organization: this.organization.toString(),
    project: idOf(this.project),
    requestedBy: summarizeUser(this.requestedBy),
    topic: this.topic,
    reason: this.reason,
    requestedMembers: this.requestedMembers.map(summarizeUser),
    preferredDate: this.preferredDate,
    preferredTime: this.preferredTime,
    status: this.status,
    decidedBy: idOf(this.decidedBy),
    decidedAt: this.decidedAt,
    decisionRemarks: this.decisionRemarks,
    resultingMeeting: idOf(this.resultingMeeting),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('MeetingRequest', meetingRequestSchema);
