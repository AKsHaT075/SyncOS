const AppError = require('./app-error');
const { addDaysToDateString, isValidTimeZone, localDateOf, parseDateOnly, wallToUtc } = require('./timezone');

/**
 * Date ranges for AI tools. NODE computes every boundary; the model only names a range ("this_week") and never supplies a date.
 *
 * Rules (decision D4):
 *   - Days are the user's LOCAL calendar days in their configured timezone (never the server's zone).
 *   - A week is Monday through Sunday (not the user's calendar "week starts on" preference).
 *   - `next_7_days` / `next_14_days` are rolling ranges of whole local days that START TODAY: today .. today+6 / today .. today+13.
 *   - Two kinds of value are compared against a range, and they are NOT interchangeable:
 *       * date-only fields (task / project due dates) are FLOATING: stored at UTC midnight and compared with the range's
 *         `fromDateUtc` / `toDateUtc` (UTC-midnight Dates). They are never shifted into a timezone.
 *       * timestamps (meeting start / end) are instants, compared with `startMs` / `endMs`: the instants of local midnight at the
 *         start of the first day and at the start of the day AFTER the last day. Each boundary is converted on its own, so a
 *         day that is 23 or 25 hours long (daylight-saving change) is handled correctly.
 */

const RANGES = Object.freeze(['today', 'next_7_days', 'this_week', 'next_14_days']);
const DAY_MS = 86400000;

const utcMidnight = (dateString) => parseDateOnly(dateString);
const parts = (dateString) => dateString.split('-').map(Number);

/** 0 = Monday ... 6 = Sunday for a 'YYYY-MM-DD' date (a pure calendar computation: no timezone involved). */
function mondayIndex(dateString) {
  return (new Date(utcMidnight(dateString)).getUTCDay() + 6) % 7;
}

/** The user's LOCAL date ('YYYY-MM-DD') at instant `nowMs`. */
function todayIn(nowMs, timeZone) {
  assertZone(timeZone);
  return localDateOf(nowMs, timeZone);
}

function assertZone(timeZone) {
  if (!isValidTimeZone(timeZone)) throw new AppError('Invalid timezone', 500, 'AI_TOOL_FAILED');
}

/** Number of days a named range covers, and where it starts relative to today. */
function dayWindow(name, today) {
  if (name === 'today') return { from: today, days: 1 };
  if (name === 'next_7_days') return { from: today, days: 7 };
  if (name === 'next_14_days') return { from: today, days: 14 };
  if (name === 'this_week') return { from: addDaysToDateString(today, -mondayIndex(today)), days: 7 };
  throw new AppError('Unknown range', 500, 'AI_TOOL_FAILED');
}

/**
 * @param {{ range: string, nowMs: number, timeZone: string }} input
 * @returns {{ name, timeZone, today, fromDate, toDate, startMs, endMs, fromDateUtc, toDateUtc }}
 *   fromDate / toDate are inclusive local dates. startMs..endMs is the half-open instant interval [start of fromDate, start of the day after toDate).
 */
function computeRange({ range, nowMs, timeZone }) {
  assertZone(timeZone);
  const today = todayIn(nowMs, timeZone);
  const { from, days } = dayWindow(range, today);
  const toDate = addDaysToDateString(from, days - 1);
  const dayAfter = addDaysToDateString(toDate, 1);
  const instantOf = (date) => {
    const [year, month, day] = parts(date);
    return wallToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
  };
  return {
    name: range,
    timeZone,
    today,
    fromDate: from,
    toDate,
    startMs: instantOf(from),
    endMs: instantOf(dayAfter),
    fromDateUtc: new Date(utcMidnight(from)),
    toDateUtc: new Date(utcMidnight(toDate)),
  };
}

/** Due-date windows for the task tool, as UTC-midnight Dates for floating date-only values. */
function dueWindow({ due, nowMs, timeZone }) {
  const today = todayIn(nowMs, timeZone);
  const todayUtc = new Date(utcMidnight(today));
  if (due === 'overdue') return { today, filter: { $ne: null, $lt: todayUtc } }; // strictly before today: due today is NOT overdue
  if (due === 'today') return { today, filter: todayUtc };
  if (due === 'none') return { today, filter: null };
  const r = computeRange({ range: due, nowMs, timeZone });
  return { today, filter: { $gte: r.fromDateUtc, $lte: r.toDateUtc }, range: r };
}

/** Sort key for schedule entries: local day, all-day entries first, then start time, then title. */
function scheduleSortKey(entry, timeZone) {
  const day = entry.allDay ? entry.startDate : localDateOf(Date.parse(entry.start), timeZone);
  return [day, entry.allDay ? 0 : 1, entry.allDay ? 0 : Date.parse(entry.start), entry.title, entry.id];
}

function compareSchedule(a, b, timeZone) {
  const ka = scheduleSortKey(a, timeZone);
  const kb = scheduleSortKey(b, timeZone);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

module.exports = { DAY_MS, RANGES, compareSchedule, computeRange, dueWindow, mondayIndex, todayIn };
