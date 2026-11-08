/**
 * Calendar-date helpers. A "ymd" ("2026-03-08") is a CIVIL date with no timezone: all arithmetic uses UTC
 * internals so the browser's own timezone can never shift a day. Instants (ms) are converted to the viewer's
 * chosen timezone with Intl, never with the browser's local zone.
 */

const DAY_MS = 86400000;

export const parseYmd = (ymd) => {
  const [year, month, day] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};
export const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (ymd, days) => toYmd(parseYmd(ymd) + days * DAY_MS);
export const diffDays = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);
export const weekdayOf = (ymd) => new Date(parseYmd(ymd)).getUTCDay();
export const startOfWeek = (ymd, weekStartsOn) => addDays(ymd, -((weekdayOf(ymd) - weekStartsOn + 7) % 7));
export const startOfMonth = (ymd) => `${ymd.slice(0, 7)}-01`;

export function addMonths(ymd, count) {
  const [year, month, day] = ymd.split("-").map(Number);
  const index = year * 12 + (month - 1) + count;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

export function daysInRange(startYmd, endYmd) {
  const days = [];
  for (let day = startYmd; day <= endYmd; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The 6-week grid that contains the month of `anchor`. */
export function monthGrid(anchor, weekStartsOn) {
  const start = startOfWeek(startOfMonth(anchor), weekStartsOn);
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  return { start, end: days[41], days };
}

// ---- instants in a timezone ------------------------------------------------

const formatters = new Map();
function formatter(key, timeZone, options) {
  const cacheKey = `${key}|${timeZone}`;
  if (!formatters.has(cacheKey)) formatters.set(cacheKey, new Intl.DateTimeFormat("en-US", { timeZone, ...options }));
  return formatters.get(cacheKey);
}

export function ymdInZone(ms, timeZone) {
  const parts = {};
  formatter("ymd", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms))
    .forEach(({ type, value }) => { parts[type] = value; });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Minutes since local midnight for an instant, in `timeZone` (0..1439). */
export function minutesInZone(ms, timeZone) {
  const parts = {};
  formatter("hm", timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms))
    .forEach(({ type, value }) => { parts[type] = value; });
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

export const todayYmd = (timeZone) => ymdInZone(Date.now(), timeZone);

export function formatTime(ms, timeZone) {
  return formatter("time", timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export function formatHourLabel(hour) {
  const period = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return hour === 0 ? "" : `${display} ${period}`;
}

const civil = (options) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
export const formatYmd = (ymd, options) => civil(options).format(new Date(parseYmd(ymd)));
export const formatMonthYear = (ymd) => formatYmd(ymd, { month: "long", year: "numeric" });
export const formatDayLong = (ymd) => formatYmd(ymd, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
export const formatDayShort = (ymd) => formatYmd(ymd, { weekday: "short", month: "short", day: "numeric" });
export const weekdayLabel = (weekday, style = "short") =>
  civil({ weekday: style }).format(new Date(Date.UTC(2023, 0, 1 + weekday))); // 2023-01-01 is a Sunday

/** "GMT-5" style label for a zone at an instant. */
export function zoneLabel(timeZone, ms = Date.now()) {
  const part = formatter("zone", timeZone, { timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function allTimeZones() {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC", browserTimeZone()];
  }
}

/** Splits an ISO instant into the date + time strings a form shows, in `timeZone`. */
export function instantToFormParts(iso, timeZone) {
  const ms = new Date(iso).getTime();
  const minutes = minutesInZone(ms, timeZone);
  return { date: ymdInZone(ms, timeZone), time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` };
}

/** "Tue, Mar 10" for an instant, as seen in `timeZone`. */
export function formatInstantDay(ms, timeZone) {
  return formatter("day", timeZone, { weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
}

/** Human summary of when an item happens, in the viewer's zone. */
export function describeWhen(item, timeZone) {
  if (item.allDay) {
    return item.startDate === item.endDate
      ? formatYmd(item.startDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : `${formatYmd(item.startDate, { weekday: "short", month: "short", day: "numeric" })} – ${formatYmd(item.endDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
  }
  const start = new Date(item.start).getTime();
  const end = new Date(item.end).getTime();
  const sameDay = ymdInZone(start, timeZone) === ymdInZone(end - 1, timeZone);
  return sameDay
    ? `${formatInstantDay(start, timeZone)} · ${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`
    : `${formatInstantDay(start, timeZone)} ${formatTime(start, timeZone)} – ${formatInstantDay(end, timeZone)} ${formatTime(end, timeZone)}`;
}
