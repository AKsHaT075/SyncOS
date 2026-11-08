const { z } = require('zod');
const {
  ATTENDEE_STATUS,
  CALENDAR_SCOPES,
  CALENDAR_VIEWS,
  EVENT_TYPES,
  EVENT_VISIBILITY,
  LIMITS,
  RECURRENCE_FREQ,
} = require('../constants/calendar.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
// Either an instant ("…Z" / with offset) or a wall-clock time ("2026-03-08T09:00")
// interpreted in the event's timezone — the server does the conversion, once.
const dateTime = z.string().trim().min(10).max(40);

// Every legend category the UI can toggle.
const CALENDAR_CATEGORIES = [...Object.values(EVENT_TYPES), 'meeting', 'task', 'project'];

const recurrenceSchema = z
  .object({
    freq: z.enum(Object.values(RECURRENCE_FREQ)),
    interval: z.number().int().min(1).max(LIMITS.MAX_RECURRENCE_INTERVAL).default(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    monthly: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('date'), day: z.number().int().min(1).max(31) }).strict(),
        z.object({
          mode: z.literal('nthWeekday'),
          nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
          weekday: z.number().int().min(0).max(6),
        }).strict(),
      ])
      .optional(),
    until: z.string().trim().min(10).max(40).nullable().optional(),
    count: z.number().int().min(1).max(LIMITS.MAX_RECURRENCE_COUNT).nullable().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.until && rule.count) {
      ctx.addIssue({ code: 'custom', path: ['count'], message: 'Choose either an end date or a number of occurrences' });
    }
    if (rule.byWeekday && rule.freq !== RECURRENCE_FREQ.WEEKLY) {
      ctx.addIssue({ code: 'custom', path: ['byWeekday'], message: 'Weekdays only apply to weekly recurrence' });
    }
    if (rule.monthly && rule.freq !== RECURRENCE_FREQ.MONTHLY) {
      ctx.addIssue({ code: 'custom', path: ['monthly'], message: 'Monthly options only apply to monthly recurrence' });
    }
  });

const reminderSchema = z
  .object({
    minutesBefore: z.number().int().min(1).max(LIMITS.MAX_REMINDER_MINUTES),
    email: z.boolean().default(false),
  })
  .strict();

const urlOrEmpty = z.union([z.literal(''), z.string().trim().url().max(500).refine((v) => /^https?:\/\//i.test(v), 'Use an http(s) link')]);

const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  location: z.string().trim().max(300).optional(),
  meetingUrl: urlOrEmpty.optional(),
  attendees: z.array(objectId).max(LIMITS.MAX_ATTENDEES).optional(),
  allDay: z.boolean().optional(),
  start: dateTime.or(dateOnly),
  end: dateTime.or(dateOnly),
  timezone: z.string().trim().min(1).max(64).optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  reminders: z.array(reminderSchema).max(LIMITS.MAX_REMINDERS).optional(),
};

const createEventSchema = z
  .object({
    ...eventFields,
    type: z.enum(Object.values(EVENT_TYPES)),
    visibility: z.enum(Object.values(EVENT_VISIBILITY)).optional(),
    teamId: objectId.optional(),
    projectId: objectId.optional(),
  })
  .strict();

// `type`, team, project and visibility are fixed at creation: they decide who may
// manage the event, so changing them would be a privilege change, not an edit.
const updateEventSchema = z
  .object({
    ...Object.fromEntries(Object.entries(eventFields).map(([key, schema]) => [key, schema.optional()])),
    scope: z.enum(['series', 'occurrence']).default('series'),
    occurrenceStart: z.string().trim().min(5).max(40).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).some((key) => !['scope', 'occurrenceStart'].includes(key)), {
    message: 'At least one field to update is required',
    path: ['title'],
  });

const deleteEventQuerySchema = z
  .object({ scope: z.enum(['series', 'occurrence']).default('series'), occurrenceStart: z.string().trim().min(5).max(40).optional() })
  .strict();

const rsvpSchema = z.object({ status: z.enum([ATTENDEE_STATUS.ACCEPTED, ATTENDEE_STATUS.DECLINED, ATTENDEE_STATUS.TENTATIVE]) }).strict();

const categoryList = z
  .string()
  .max(200)
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(CALENDAR_CATEGORIES)).max(CALENDAR_CATEGORIES.length));

const calendarQuerySchema = z
  .object({
    // Dates are the visible calendar days in the user's timezone (inclusive);
    // the server converts them to UTC instants.
    fromDate: dateOnly,
    toDate: dateOnly,
    tz: z.string().trim().min(1).max(64).optional(),
    scope: z.enum(Object.values(CALENDAR_SCOPES)).default(CALENDAR_SCOPES.PERSONAL),
    teamId: objectId.optional(),
    projectId: objectId.optional(),
    assigneeId: objectId.optional(),
    types: categoryList.optional(),
    status: z.string().trim().max(30).optional(),
    q: z.string().trim().max(120).optional(),
    includeCancelled: z.enum(['true', 'false']).default('false'),
  })
  .strict();

const updatePreferencesSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64).nullable().optional(),
    weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional(),
    defaultView: z.enum(CALENDAR_VIEWS).optional(),
    hiddenCategories: z.array(z.enum(CALENDAR_CATEGORIES)).max(CALENDAR_CATEGORIES.length).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one preference to update is required', path: ['timezone'] });

module.exports = {
  CALENDAR_CATEGORIES,
  calendarQuerySchema,
  createEventSchema,
  deleteEventQuerySchema,
  rsvpSchema,
  updateEventSchema,
  updatePreferencesSchema,
};
