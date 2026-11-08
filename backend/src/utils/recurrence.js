const { LIMITS, RECURRENCE_FREQ } = require('../constants/calendar.constants');
const { wallToUtc, zonedParts } = require('./timezone');

/**
 * Recurrence is stored as a RULE and expanded on demand inside a bounded date
 * window — occurrences are never pre-generated.
 *
 *   rule = {
 *     freq:     'daily' | 'weekly' | 'monthly',
 *     interval: 1..99                       every N days / weeks / months
 *     byWeekday:[0..6]                      weekly: which weekdays (0 = Sunday)
 *     monthly:  { mode: 'date', day }       day of month (clamped to the month's last day)
 *             | { mode: 'nthWeekday', nth, weekday }   nth = 1..4 or -1 (last)
 *     until:    Date | null                 last allowed occurrence START (inclusive)
 *     count:    1..1000 | null              total occurrences (instead of `until`)
 *   }
 *
 * Expansion works on WALL-CLOCK dates in the event's timezone and converts
 * each occurrence start to UTC, so "every Monday 09:00" stays at 09:00 local
 * across daylight-saving changes (the UTC instant moves, the wall time doesn't).
 * The duration is held constant in absolute time.
 * All-day events use floating dates (UTC midnight, no timezone).
 */

const DAY_MS = 86400000;

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayOf = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
const addDays = ({ year, month, day }, n) => {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const daysBetween = (a, b) => Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);

function nthWeekdayOfMonth(year, month, nth, weekday) {
  const total = daysInMonth(year, month);
  if (nth > 0) {
    const day = 1 + ((weekday - weekdayOf(year, month, 1) + 7) % 7) + (nth - 1) * 7;
    return day <= total ? day : null; // e.g. there is no 5th Friday
  }
  return total - ((weekdayOf(year, month, total) - weekday + 7) % 7); // last
}

/** Yields candidate local dates (in order) for a rule, starting at period index `k0`. */
function* candidateDates(rule, start, k0) {
  const interval = rule.interval || 1;

  if (rule.freq === RECURRENCE_FREQ.DAILY) {
    for (let k = k0; ; k += 1) yield addDays(start, k * interval);
    return;
  }

  if (rule.freq === RECURRENCE_FREQ.WEEKLY) {
    const weekdays = [...new Set(rule.byWeekday?.length ? rule.byWeekday : [weekdayOf(start.year, start.month, start.day)])]
      .map((weekday) => (weekday + 6) % 7) // offset from Monday
      .sort((a, b) => a - b);
    const anchor = addDays(start, -((weekdayOf(start.year, start.month, start.day) + 6) % 7)); // Monday of the first week
    for (let w = k0; ; w += 1) {
      for (const offset of weekdays) {
        const date = addDays(anchor, w * interval * 7 + offset);
        if (daysBetween(start, date) >= 0) yield date;
      }
    }
  }

  if (rule.freq === RECURRENCE_FREQ.MONTHLY) {
    const monthly = rule.monthly || { mode: 'date', day: start.day };
    for (let k = k0; ; k += 1) {
      const index = start.month - 1 + k * interval;
      const year = start.year + Math.floor(index / 12);
      const month = (((index % 12) + 12) % 12) + 1;
      let day;
      if (monthly.mode === 'nthWeekday') {
        day = nthWeekdayOfMonth(year, month, monthly.nth, monthly.weekday);
      } else {
        day = Math.min(monthly.day ?? start.day, daysInMonth(year, month));
      }
      if (day && daysBetween(start, { year, month, day }) >= 0) yield { year, month, day };
    }
  }
}

/** First period index worth generating for a window starting at `rangeStartDate` (never overshoots). */
function fastForwardIndex(rule, start, rangeStartDate) {
  const interval = rule.interval || 1;
  const days = daysBetween(start, rangeStartDate);
  if (days <= 0) return 0;
  if (rule.freq === RECURRENCE_FREQ.DAILY) return Math.max(0, Math.floor(days / interval) - 1);
  if (rule.freq === RECURRENCE_FREQ.WEEKLY) return Math.max(0, Math.floor(days / 7 / interval) - 1);
  const months = (rangeStartDate.year - start.year) * 12 + (rangeStartDate.month - start.month);
  return Math.max(0, Math.floor(months / interval) - 1);
}

/**
 * Expands a recurring event into the occurrences that overlap [rangeStart, rangeEnd).
 *
 * event: { start: ms, end: ms, allDay, timezone, recurrence: rule }
 * Returns [{ originalStart, start, end }] (ms), ordered, at most `limit`.
 * `originalStart` is the occurrence's stable identity — it never changes when
 * a single occurrence is later moved or edited.
 */
function expandRecurrence(event, rangeStart, rangeEnd, { limit = LIMITS.MAX_OCCURRENCES_PER_REQUEST } = {}) {
  const rule = event.recurrence;
  if (!rule || rangeEnd <= rangeStart) return [];

  const duration = Math.max(0, event.end - event.start);
  const timeZone = event.allDay ? 'UTC' : event.timezone;
  const first = zonedParts(event.start, timeZone);
  const start = { year: first.year, month: first.month, day: first.day };
  const hour = event.allDay ? 0 : first.hour;
  const minute = event.allDay ? 0 : first.minute;

  const toInstant = (date) => (event.allDay
    ? Date.UTC(date.year, date.month - 1, date.day)
    : wallToUtc({ ...date, hour, minute }, timeZone));

  // Without a COUNT we can skip straight to the window; with one we must count from the start.
  let k0 = 0;
  if (!rule.count) {
    const bufferDays = Math.ceil(duration / DAY_MS) + 2;
    const windowStart = zonedParts(rangeStart - bufferDays * DAY_MS, timeZone);
    k0 = fastForwardIndex(rule, start, { year: windowStart.year, month: windowStart.month, day: windowStart.day });
  }

  const until = rule.until ? new Date(rule.until).getTime() : Infinity;
  const occurrences = [];
  let produced = rule.count ? 0 : null;
  let iterations = 0;

  for (const date of candidateDates(rule, start, k0)) {
    iterations += 1;
    if (iterations > LIMITS.EXPANSION_ITERATION_CAP) break;

    const originalStart = toInstant(date);
    if (originalStart > until) break;
    if (rule.count) {
      produced += 1;
      if (produced > rule.count) break;
    }
    if (originalStart >= rangeEnd) break;

    const originalEnd = originalStart + duration;
    if (originalEnd > rangeStart || (duration === 0 && originalStart >= rangeStart)) {
      occurrences.push({ originalStart, start: originalStart, end: originalEnd });
      if (occurrences.length >= limit) break;
    }
  }
  return occurrences;
}

/** True if `originalStart` is a genuine occurrence of the series (guards against forged exceptions). */
function isOccurrenceOf(event, originalStart) {
  return expandRecurrence(event, originalStart, originalStart + 1, { limit: 5 }).some((o) => o.originalStart === originalStart);
}

module.exports = { expandRecurrence, isOccurrenceOf, nthWeekdayOfMonth };
