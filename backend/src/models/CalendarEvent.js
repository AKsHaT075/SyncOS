const mongoose = require('mongoose');
const {
  ATTENDEE_STATUS,
  EVENT_STATUS,
  EVENT_TYPES,
  EVENT_VISIBILITY,
  RECURRENCE_FREQ,
} = require('../constants/calendar.constants');

const attendeeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(ATTENDEE_STATUS), default: ATTENDEE_STATUS.INVITED },
  },
  { _id: false },
);

const recurrenceSchema = new mongoose.Schema(
  {
    freq: { type: String, enum: Object.values(RECURRENCE_FREQ), required: true },
    interval: { type: Number, default: 1, min: 1, max: 99 },
    byWeekday: { type: [Number], default: undefined },
    monthly: {
      mode: { type: String, enum: ['date', 'nthWeekday'] },
      day: Number,
      nth: Number,
      weekday: Number,
    },
    until: { type: Date, default: null },
    count: { type: Number, default: null },
  },
  { _id: false },
);

// A single occurrence of a recurring series that was changed or removed.
// Keyed by `originalStart` — the occurrence's immutable identity.
const exceptionSchema = new mongoose.Schema(
  {
    originalStart: { type: Date, required: true },
    cancelled: { type: Boolean, default: false },
    title: String,
    description: String,
    location: String,
    meetingUrl: String,
    start: Date,
    end: Date,
  },
  { _id: false },
);

const reminderSchema = new mongoose.Schema(
  { minutesBefore: { type: Number, required: true, min: 1 }, email: { type: Boolean, default: false } },
  { _id: false },
);

const calendarEventSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 5000 },
    location: { type: String, default: '', trim: true, maxlength: 300 },
    meetingUrl: { type: String, default: '', trim: true, maxlength: 500 },

    type: { type: String, enum: Object.values(EVENT_TYPES), required: true },
    visibility: { type: String, enum: Object.values(EVENT_VISIBILITY), required: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attendees: { type: [attendeeSchema], default: [] },

    // Timed events: instants in UTC. All-day events: floating dates stored as
    // UTC midnight, `end` exclusive (the day after the last day) — never
    // shifted by any timezone.
    allDay: { type: Boolean, default: false },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    // IANA zone the event was authored in; recurrence expands on its wall clock.
    timezone: { type: String, default: 'UTC' },

    recurrence: { type: recurrenceSchema, default: null },
    exceptions: { type: [exceptionSchema], default: [] },
    reminders: { type: [reminderSchema], default: [] },

    status: { type: String, enum: Object.values(EVENT_STATUS), default: EVENT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Date-range queries (non-recurring events overlap a window).
calendarEventSchema.index({ organization: 1, deletedAt: 1, start: 1, end: 1 });
// Recurring series whose rule could reach a window.
calendarEventSchema.index({ organization: 1, deletedAt: 1, 'recurrence.until': 1, start: 1 });
calendarEventSchema.index({ organization: 1, owner: 1, start: 1 });
calendarEventSchema.index({ organization: 1, 'attendees.user': 1, start: 1 });
calendarEventSchema.index({ organization: 1, team: 1, start: 1 });
calendarEventSchema.index({ organization: 1, project: 1, start: 1 });
// Reminder job: upcoming events that have reminders.
calendarEventSchema.index({ status: 1, deletedAt: 1, start: 1 }, { partialFilterExpression: { 'reminders.0': { $exists: true } } });

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
