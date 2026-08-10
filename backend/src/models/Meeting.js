const mongoose = require('mongoose');
const {
  MEETING_TYPE,
  MEETING_STATUS,
  MEETING_PARTICIPANT_ROLE,
  MEETING_PARTICIPANT_STATUS,
  MEETING_ROOM_STATUS,
} = require('../constants/meeting.constants');

const participantSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: Object.values(MEETING_PARTICIPANT_ROLE),
      default: MEETING_PARTICIPANT_ROLE.PARTICIPANT,
    },
    status: {
      type: String,
      enum: Object.values(MEETING_PARTICIPANT_STATUS),
      default: MEETING_PARTICIPANT_STATUS.INVITED,
    },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
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
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    type: {
      type: String,
      enum: Object.values(MEETING_TYPE),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(MEETING_STATUS),
      default: MEETING_STATUS.SCHEDULED,
      index: true,
    },
    /**
     * Required for a Scheduled meeting. An Instant meeting sets startTime to
     * the creation moment and leaves endTime null — there is no fixed
     * duration, it ends when the host ends it or the room empties out.
     */
    startTime: {
      type: Date,
      required: true,
    },
    endTime: {
      type: Date,
      default: null,
    },
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    participants: {
      type: [participantSchema],
      default: [],
    },
    /**
     * Room is created lazily (first join-token request), not at schedule
     * time — see meetingAccess/meeting.service. `roomStatus` tracks LiveKit
     * room lifecycle independent of `status`, since a meeting can be Active
     * (room created) while the webhook hasn't yet confirmed it ended.
     */
    livekitRoomName: {
      type: String,
      default: null,
    },
    roomStatus: {
      type: String,
      enum: Object.values(MEETING_ROOM_STATUS),
      default: MEETING_ROOM_STATUS.NONE,
    },
    /**
     * When the auto-cleanup sweep first observed zero live participants in
     * an Active room; reset to null the moment someone is present again.
     * Lets the sweep tell "just went empty" apart from "empty for a while"
     * across runs without needing its own separate store.
     */
    roomEmptyDetectedAt: {
      type: Date,
      default: null,
    },
    sourceRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeetingRequest',
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

meetingSchema.index({ organization: 1, project: 1, status: 1 });
meetingSchema.index({ organization: 1, project: 1, startTime: 1 });
meetingSchema.index({ 'participants.user': 1 });

// `host`/`participants.user`/`project` may come in populated or as bare
// ObjectIds depending on the query that loaded this document.
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

function summarizeProject(value) {
  if (!value) return null;
  if (value.name) {
    return { id: value._id.toString(), name: value.name };
  }
  return { id: value.toString() };
}

meetingSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: this._id.toString(),
    organization: this.organization.toString(),
    project: summarizeProject(this.project),
    topic: this.topic,
    description: this.description,
    type: this.type,
    status: this.status,
    startTime: this.startTime,
    endTime: this.endTime,
    host: summarizeUser(this.host),
    participants: this.participants.map((participant) => ({
      user: summarizeUser(participant.user),
      role: participant.role,
      status: participant.status,
      invitedAt: participant.invitedAt,
      respondedAt: participant.respondedAt,
      joinedAt: participant.joinedAt,
      leftAt: participant.leftAt,
    })),
    livekitRoomName: this.livekitRoomName,
    roomStatus: this.roomStatus,
    sourceRequest: idOf(this.sourceRequest),
    cancelledAt: this.cancelledAt,
    cancelledBy: idOf(this.cancelledBy),
    createdBy: idOf(this.createdBy),
    updatedBy: idOf(this.updatedBy),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Meeting', meetingSchema);
