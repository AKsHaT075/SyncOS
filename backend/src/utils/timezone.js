/**
 * IANA-timezone arithmetic built on Intl (no dependency). The one rule that
 * keeps calendars correct: store instants in UTC, and convert to/from a zone's
 * WALL-CLOCK time only at the edges (user input, recurrence expansion, display).
 */

const formatters = new Map();
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in `timeZone`. weekday: 0 = Sunday. */
function zonedParts(utcMs, timeZone) {
  const parts = {};
  formatterFor(timeZone).formatToParts(new Date(utcMs)).forEach(({ type, value }) => {
    parts[type] = value;
  });
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

/** UTC offset of the zone at an instant, in minutes (e.g. New York in winter: -300). */
function offsetMinutes(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wallAsUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant (ms).
 *  - Normal times map one-to-one.
 *  - Ambiguous times (clocks fall back; 01:30 happens twice) resolve to the
 *    FIRST occurrence — the earlier instant.
 *  - Nonexistent times (clocks spring forward; 02:30 never happens) resolve
 *    forward by the length of the gap (02:30 → 03:30), like Google/Outlook.
 */
function wallToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMinutes(guess - 86400000, timeZone);
  const after = offsetMinutes(guess + 86400000, timeZone);

  const matches = [...new Set([before, after])]
    .map((offset) => guess - offset * 60000)
    .filter((candidate) => {
      const p = zonedParts(candidate, timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b);

  if (matches.length > 0) return matches[0];
  return guess - before * 60000; // inside a spring-forward gap
}

const pad = (value, length = 2) => String(value).padStart(length, '0');

const dateString = ({ year, month, day }) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** 'YYYY-MM-DD' of an instant as seen in `timeZone`. */
function localDateOf(utcMs, timeZone) {
  return dateString(zonedParts(utcMs, timeZone));
}

/** 'YYYY-MM-DDTHH:mm' wall-clock of an instant in `timeZone` (what an event form shows). */
function localDateTimeOf(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  return `${dateString(p)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

function isRealDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** 'YYYY-MM-DD' → UTC-midnight ms (date-only values are FLOATING: no timezone applied). */
function parseDateOnly(value) {
  const match = DATE_RE.exec(value || '');
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return isRealDate(year, month, day) ? Date.UTC(year, month - 1, day) : null;
}

/** UTC-midnight ms → 'YYYY-MM-DD' (reads UTC parts; never shifts with any timezone). */
function dateOnlyString(utcMidnightMs) {
  const d = new Date(utcMidnightMs);
  return dateString({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/**
 * Parses either an absolute instant ("2026-03-08T14:00:00Z" / with offset) or a
 * wall-clock string ("2026-03-08T09:00") interpreted in `timeZone`. Returns ms
 * or null.
 */
function parseDateTime(value, timeZone) {
  if (typeof value !== 'string') return null;
  const wall = DATETIME_RE.exec(value);
  if (wall) {
    const [year, month, day, hour, minute] = wall.slice(1).map(Number);
    if (!isRealDate(year, month, day) || hour > 23 || minute > 59) return null;
    return wallToUtc({ year, month, day, hour, minute }, timeZone);
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function addDaysToDateString(date, days) {
  return dateOnlyString(parseDateOnly(date) + days * 86400000);
}

module.exports = {
  addDaysToDateString,
  dateOnlyString,
  isValidTimeZone,
  localDateOf,
  localDateTimeOf,
  offsetMinutes,
  parseDateOnly,
  parseDateTime,
  wallToUtc,
  zonedParts,
};
