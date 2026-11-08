import { CATEGORY_BY_VALUE } from "@/features/calendar/constants/calendarOptions";
import { addDays, daysInRange, ymdInZone } from "@/features/calendar/utils/dates";

/** The calendar days (ymd, in the viewer's zone) an item touches. All-day items are floating dates. */
export function itemDays(item, timeZone) {
  if (item.allDay) return daysInRange(item.startDate, item.endDate);
  const start = new Date(item.start).getTime();
  const end = new Date(item.end).getTime();
  const first = ymdInZone(start, timeZone);
  const last = end > start ? ymdInZone(end - 1, timeZone) : first; // an event ending exactly at midnight stays on the earlier day
  return daysInRange(first, last < first ? first : last);
}

export function bucketByDay(items, timeZone) {
  const buckets = new Map();
  items.forEach((item) => {
    itemDays(item, timeZone).forEach((day) => {
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(item);
    });
  });
  return buckets;
}

export const categoryOf = (item) => CATEGORY_BY_VALUE[item.category] ?? CATEGORY_BY_VALUE.general;

/** Dimmed/struck-through treatment for finished or cancelled things. */
export const isMuted = (item) => Boolean(item.done) || item.status === "Cancelled" || item.status === "Ended";
export const isCancelled = (item) => item.status === "Cancelled";

export function splitAllDay(items) {
  return { allDay: items.filter((item) => item.allDay), timed: items.filter((item) => !item.allDay) };
}

export const sortForDay = (items) =>
  [...items].sort((a, b) => Number(b.allDay) - Number(a.allDay) || new Date(a.start || 0) - new Date(b.start || 0) || a.title.localeCompare(b.title));

export { addDays };
