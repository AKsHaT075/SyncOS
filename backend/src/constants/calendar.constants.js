const EVENT_TYPES = Object.freeze({
  GENERAL: 'general',
  TEAM: 'team',
  ORGANIZATION: 'organization',
  PERSONAL: 'personal',
});

// Who can see an event (besides its owner and invited attendees, who always can).
const EVENT_VISIBILITY = Object.freeze({
  PARTICIPANTS: 'participants', // owner + attendees only
  PROJECT: 'project', // members of the event's project
  TEAM: 'team', // members of the event's team
  ORGANIZATION: 'organization', // everyone in the organization except guests
});

// Visibility each event type may use (first = default).
const TYPE_VISIBILITY = Object.freeze({
  [EVENT_TYPES.PERSONAL]: [EVENT_VISIBILITY.PARTICIPANTS],
  [EVENT_TYPES.GENERAL]: [EVENT_VISIBILITY.PARTICIPANTS, EVENT_VISIBILITY.PROJECT],
  [EVENT_TYPES.TEAM]: [EVENT_VISIBILITY.TEAM],
  [EVENT_TYPES.ORGANIZATION]: [EVENT_VISIBILITY.ORGANIZATION],
});

const ATTENDEE_STATUS = Object.freeze({
  INVITED: 'invited',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
});

const EVENT_STATUS = Object.freeze({ ACTIVE: 'active', CANCELLED: 'cancelled' });

const RECURRENCE_FREQ = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' });

const ITEM_SOURCES = Object.freeze({ EVENT: 'event', MEETING: 'meeting', TASK: 'task', PROJECT: 'project' });
const CALENDAR_SCOPES = Object.freeze({ PERSONAL: 'personal', TEAM: 'team', ORGANIZATION: 'organization' });
const CALENDAR_VIEWS = Object.freeze(['month', 'week', 'day', 'agenda']);

const LIMITS = Object.freeze({
  MAX_RANGE_DAYS: 100, // widest window one request may ask for (month grid + agenda page)
  MAX_ATTENDEES: 100,
  MAX_REMINDERS: 5,
  MAX_REMINDER_MINUTES: 7 * 24 * 60, // custom reminders up to a week
  MAX_RECURRENCE_COUNT: 1000,
  MAX_RECURRENCE_INTERVAL: 99,
  MAX_EXCEPTIONS: 500,
  MAX_OCCURRENCES_PER_REQUEST: 2000, // expansion cap
  MAX_ITEMS_PER_SOURCE: 1500,
  EXPANSION_ITERATION_CAP: 6000,
});

// Presets offered in the UI; any value 1..MAX_REMINDER_MINUTES is accepted (custom).
const REMINDER_PRESETS = Object.freeze([5, 15, 30, 60, 1440]);
// Reminders more than this late are skipped (a job outage shouldn't replay stale alerts).
const REMINDER_LATE_GRACE_MS = 15 * 60 * 1000;

// Used when neither the user nor the organization has chosen a timezone: India Standard Time.
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000; // for meetings without an end time

module.exports = {
  ATTENDEE_STATUS,
  CALENDAR_SCOPES,
  CALENDAR_VIEWS,
  DEFAULT_MEETING_DURATION_MS,
  DEFAULT_TIME_ZONE,
  EVENT_STATUS,
  EVENT_TYPES,
  EVENT_VISIBILITY,
  ITEM_SOURCES,
  LIMITS,
  RECURRENCE_FREQ,
  REMINDER_LATE_GRACE_MS,
  REMINDER_PRESETS,
  TYPE_VISIBILITY,
};
