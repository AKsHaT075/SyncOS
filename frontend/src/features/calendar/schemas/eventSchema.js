import { z } from "zod";
import { weekdayOf } from "@/features/calendar/utils/dates";

const reminderSchema = z.object({ minutesBefore: z.coerce.number().int().min(1, "At least 1 minute").max(10080, "At most 7 days"), email: z.boolean() });

export const eventFormSchema = z
  .object({
    title: z.string().trim().min(1, "Give the event a title").max(200, "Keep it under 200 characters"),
    type: z.enum(["personal", "general", "team", "organization"]),
    allDay: z.boolean(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a start date"),
    startTime: z.string(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose an end date"),
    endTime: z.string(),
    timezone: z.string().min(1, "Choose a timezone"),
    location: z.string().max(300, "Keep it under 300 characters"),
    meetingUrl: z.string().trim().refine((value) => value === "" || /^https?:\/\/\S+$/i.test(value), "Use a link starting with http:// or https://"),
    description: z.string().max(5000),
    attendees: z.array(z.object({ id: z.string(), name: z.string() })).max(100, "At most 100 invitees"),
    teamId: z.string(),
    projectId: z.string(),
    projectVisible: z.boolean(),
    recurrence: z.object({
      repeat: z.enum(["none", "daily", "weekly", "monthly"]),
      interval: z.coerce.number().int().min(1, "At least 1").max(99, "At most 99"),
      byWeekday: z.array(z.number()),
      monthlyMode: z.enum(["date", "nthWeekday"]),
      end: z.enum(["never", "until", "count"]),
      until: z.string(),
      count: z.coerce.number().int().min(1, "At least 1").max(1000, "At most 1000"),
    }),
    reminders: z.array(reminderSchema).max(5, "At most 5 reminders"),
  })
  .superRefine((v, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: "custom", path, message });
    if (!v.allDay && (!v.startTime || !v.endTime)) issue(["endTime"], "Set a start and end time");
    const start = `${v.startDate}T${v.allDay ? "00:00" : v.startTime}`;
    const end = `${v.endDate}T${v.allDay ? "00:00" : v.endTime}`;
    if (v.allDay ? v.endDate < v.startDate : end <= start) {
      issue([v.allDay ? "endDate" : "endTime"], v.allDay ? "The end date must be on or after the start date" : "The end must be after the start");
    }
    if (v.type === "team" && !v.teamId) issue(["teamId"], "Choose a team");
    const r = v.recurrence;
    if (r.repeat === "weekly") {
      if (r.byWeekday.length === 0) issue(["recurrence", "byWeekday"], "Pick at least one weekday");
      else if (!r.byWeekday.includes(weekdayOf(v.startDate))) issue(["recurrence", "byWeekday"], "The start date must fall on one of the selected weekdays");
    }
    if (r.repeat !== "none" && r.end === "until") {
      if (!r.until) issue(["recurrence", "until"], "Choose an end date");
      else if (r.until < v.startDate) issue(["recurrence", "until"], "The end date must be after the first event");
    }
  });
