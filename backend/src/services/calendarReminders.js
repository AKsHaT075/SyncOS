const { ATTENDEE_STATUS, EVENT_STATUS, LIMITS, REMINDER_LATE_GRACE_MS } = require('../constants/calendar.constants');
const CalendarEvent = require('../models/CalendarEvent');
const { expandRecurrence } = require('../utils/recurrence');
const { dateOnlyString, wallToUtc } = require('../utils/timezone');
const { eventAudience } = require('./calendar.service');
const { calendarReminder } = require('./notificationEvents');

const MIN_MS = 60 * 1000;

function humanLead(ms) {
  const minutes = Math.max(1, Math.round(ms / MIN_MS));
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60));
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The instant a reminder is measured from. Timed events: the start. All-day
 * events: midnight at the start of that date in the event's own timezone.
 */
function anchorOf(event, startMs) {
  if (!event.allDay) return startMs;
  const [year, month, day] = dateOnlyString(startMs).split('-').map(Number);
  return wallToUtc({ year, month, day, hour: 0, minute: 0 }, event.timezone);
}

/** Occurrences (after exceptions) that could still produce a reminder. */
function upcomingOccurrences(event, now, horizon) {
  const startMs = event.start.getTime();
  const endMs = event.end.getTime();
  if (!event.recurrence) return [{ start: startMs, key: startMs }];

  const exceptions = new Map(event.exceptions.map((entry) => [entry.originalStart.getTime(), entry]));
  const series = { start: startMs, end: endMs, allDay: event.allDay, timezone: event.timezone, recurrence: event.recurrence };
  const out = [];

  expandRecurrence(series, now, horizon, { limit: 200 }).forEach((occurrence) => {
    if (!exceptions.has(occurrence.originalStart)) out.push({ start: occurrence.start, key: occurrence.originalStart });
  });
  exceptions.forEach((exception, originalStart) => {
    if (exception.cancelled) return;
    const start = exception.start ? exception.start.getTime() : originalStart;
    if (start > now && start < horizon) out.push({ start, key: originalStart });
  });
  return out;
}

/**
 * Sends due event reminders through the notification system.
 *
 * Runs every minute (any number of instances): each (occurrence start,
 * reminder offset, recipient) is a deterministic dedupe key, so repeated ticks
 * never duplicate a reminder. A moved occurrence has a different start, hence a
 * fresh reminder for its new time; deleted / cancelled events and cancelled
 * occurrences are excluded by the query and the exception check. A reminder
 * more than 15 minutes late (job downtime, or an event created after its
 * reminder time had passed) is skipped rather than replayed.
 */
async function runCalendarReminders({ now = Date.now() } = {}) {
  const horizon = now + LIMITS.MAX_REMINDER_MINUTES * MIN_MS;

  const candidates = await CalendarEvent.find({
    status: EVENT_STATUS.ACTIVE,
    deletedAt: null,
    'reminders.0': { $exists: true },
    start: { $lt: new Date(horizon) },
    $or: [
      { recurrence: null, end: { $gt: new Date(now) } },
      { recurrence: { $ne: null }, $or: [{ 'recurrence.until': null }, { 'recurrence.until': { $gte: new Date(now) } }] },
    ],
  })
    .limit(500)
    .lean();

  let sent = 0;
  for (const event of candidates) {
    const occurrences = upcomingOccurrences(event, now, horizon);
    if (occurrences.length === 0) continue; // eslint-disable-line no-continue

    let audience = null; // resolved lazily, once per event
    for (const occurrence of occurrences) {
      const anchor = anchorOf(event, occurrence.start);
      if (anchor <= now) continue; // eslint-disable-line no-continue

      for (const reminder of event.reminders) {
        const fireAt = anchor - reminder.minutesBefore * MIN_MS;
        if (fireAt > now || now - fireAt > REMINDER_LATE_GRACE_MS) continue; // eslint-disable-line no-continue

        // eslint-disable-next-line no-await-in-loop
        audience = audience || (await eventAudience({ ...event, attendees: event.attendees.filter((a) => a.status !== ATTENDEE_STATUS.DECLINED) }));
        // eslint-disable-next-line no-await-in-loop
        await calendarReminder({
          event,
          userIds: audience,
          anchor,
          minutes: reminder.minutesBefore,
          when: humanLead(anchor - now),
          emailRequested: reminder.email === true,
        });
        sent += 1;
      }
    }
  }
  return { events: candidates.length, remindersProcessed: sent };
}

module.exports = { humanLead, runCalendarReminders };
