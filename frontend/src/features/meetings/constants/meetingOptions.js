// Mirrors backend/src/constants/meeting.constants.js — keep these enums in sync.
export const MEETING_TYPES = ["Scheduled", "Instant"];
export const MEETING_STATUSES = ["Scheduled", "Active", "Ended", "Cancelled"];
export const MEETING_REQUEST_STATUSES = ["Pending", "Approved", "Rejected", "Scheduled"];

export const MEETING_STATUS_STYLES = {
  Scheduled: "bg-blue-50 text-blue-700",
  Active: "bg-emerald-50 text-emerald-700",
  Ended: "bg-zinc-100 text-zinc-600",
  Cancelled: "bg-red-50 text-red-700",
};

export const MEETING_REQUEST_STATUS_STYLES = {
  Pending: "bg-amber-50 text-amber-700",
  Approved: "bg-emerald-50 text-emerald-700",
  Rejected: "bg-red-50 text-red-700",
  Scheduled: "bg-blue-50 text-blue-700",
};

// Mirrors backend/src/constants/audit.constants.js's MEETING_* audit events.
export const MEETING_ACTION_LABELS = {
  "meeting.created": "Created the meeting",
  "meeting.updated": "Updated the meeting",
  "meeting.cancelled": "Cancelled the meeting",
  "meeting.participant_added": "Added participant(s)",
  "meeting.participant_removed": "Removed a participant",
  "meeting.participant_kicked": "Removed a participant from the call",
  "meeting.started": "Started the call",
  "meeting.ended": "Ended the call",
  "meeting.joined": "Joined the call",
};
