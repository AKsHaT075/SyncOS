import { DEFAULT_TIME_ZONE } from "@/features/calendar/constants/calendarOptions";
import { addDays, instantToFormParts, parseYmd, weekdayOf } from "@/features/calendar/utils/dates";

const pad = (n) => String(n).padStart(2, "0");
const minutesToTime = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const timeToMinutes = (time) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };

export const EMPTY_RECURRENCE = { repeat: "none", interval: 1, byWeekday: [], monthlyMode: "date", end: "never", until: "", count: 10 };

/** Values for a brand-new event, optionally prefilled from a clicked day / time slot. */
export function createDefaults({ date, minutes = 9 * 60, timeZone = DEFAULT_TIME_ZONE, type = "personal" }) {
  const endMinutes = minutes + 60;
  return {
    title: "", type, allDay: false,
    startDate: date, startTime: minutesToTime(minutes),
    endDate: endMinutes >= 1440 ? addDays(date, 1) : date, endTime: minutesToTime(endMinutes),
    timezone: timeZone, location: "", meetingUrl: "", description: "",
    attendees: [], teamId: "", projectId: "", projectVisible: true,
    recurrence: { ...EMPTY_RECURRENCE, byWeekday: [weekdayOf(date)] },
    reminders: [{ minutesBefore: 15, email: false }],
  };
}

function recurrenceFromRule(rule, startDate) {
  if (!rule) return { ...EMPTY_RECURRENCE, byWeekday: [weekdayOf(startDate)] };
  return {
    repeat: rule.freq, interval: rule.interval || 1,
    byWeekday: rule.byWeekday?.length ? rule.byWeekday : [weekdayOf(startDate)],
    monthlyMode: rule.monthly?.mode === "nthWeekday" ? "nthWeekday" : "date",
    end: rule.count ? "count" : rule.untilLocal ? "until" : "never",
    until: rule.untilLocal || "", count: rule.count || 10,
  };
}

/** Form values for editing an existing event (whole series, or one occurrence of it). */
export function valuesFromEvent(detail, { scope, item }) {
  const zone = detail.timezone;
  let startDate; let startTime; let endDate; let endTime;
  if (detail.allDay) {
    startDate = scope === "occurrence" ? item.startDate : detail.startDate;
    endDate = scope === "occurrence" ? item.endDate : detail.endDate;
    startTime = "09:00"; endTime = "10:00";
  } else if (scope === "occurrence") {
    ({ date: startDate, time: startTime } = instantToFormParts(item.start, zone));
    ({ date: endDate, time: endTime } = instantToFormParts(item.end, zone));
  } else {
    [startDate, startTime] = detail.startLocal.split("T");
    [endDate, endTime] = detail.endLocal.split("T");
  }
  return {
    title: scope === "occurrence" ? item.title : detail.title,
    type: detail.type, allDay: detail.allDay, startDate, startTime, endDate, endTime, timezone: zone,
    location: scope === "occurrence" ? item.location ?? "" : detail.location,
    meetingUrl: scope === "occurrence" ? item.meetingUrl ?? "" : detail.meetingUrl,
    description: scope === "occurrence" ? item.description ?? "" : detail.description,
    attendees: detail.attendees.map((a) => ({ id: a.id, name: a.name })),
    teamId: detail.team?.id ?? "", projectId: detail.project?.id ?? "", projectVisible: detail.visibility === "project",
    recurrence: recurrenceFromRule(detail.recurrence, startDate),
    reminders: detail.reminders.map((r) => ({ minutesBefore: r.minutesBefore, email: r.email })),
  };
}

function ruleFromForm(values) {
  const { recurrence: r, startDate } = values;
  if (r.repeat === "none") return null;
  const rule = { freq: r.repeat, interval: Number(r.interval) || 1 };
  if (r.repeat === "weekly") rule.byWeekday = [...r.byWeekday].sort((a, b) => a - b);
  if (r.repeat === "monthly") {
    const day = Number(startDate.slice(8));
    rule.monthly = r.monthlyMode === "nthWeekday"
      ? { mode: "nthWeekday", nth: day > 28 ? -1 : Math.ceil(day / 7), weekday: weekdayOf(startDate) }
      : { mode: "date", day };
  }
  if (r.end === "until") rule.until = r.until;
  if (r.end === "count") rule.count = Number(r.count);
  return rule;
}

/**
 * API body. Times go out as WALL-CLOCK strings plus the zone they were typed in — the server does the one
 * and only conversion to UTC, so the browser's timezone and DST rules never enter into it.
 * An edit of a single occurrence may only carry fields an occurrence can override.
 */
export function buildPayload(values, { mode, scope }) {
  const start = values.allDay ? values.startDate : `${values.startDate}T${values.startTime}`;
  const end = values.allDay ? values.endDate : `${values.endDate}T${values.endTime}`;
  const common = {
    title: values.title.trim(), description: values.description.trim(), location: values.location.trim(),
    meetingUrl: values.meetingUrl.trim(), start, end,
  };
  if (mode === "edit" && scope === "occurrence") return common;

  const body = {
    ...common, allDay: values.allDay, timezone: values.timezone,
    attendees: values.attendees.map((a) => a.id),
    reminders: values.reminders.map((r) => ({ minutesBefore: Number(r.minutesBefore), email: Boolean(r.email) })),
    recurrence: ruleFromForm(values),
  };
  if (mode === "create") {
    body.type = values.type;
    if (values.type === "team") body.teamId = values.teamId;
    if (values.type === "general" && values.projectId) {
      body.projectId = values.projectId;
      if (values.projectVisible) body.visibility = "project";
    }
  }
  return body;
}

export { parseYmd, timeToMinutes };
