// Mirrors backend/src/constants/calendar.constants.js

export const VIEWS = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
  { value: "agenda", label: "Agenda" },
];

export const SCOPES = [
  { value: "personal", label: "Personal", description: "Your meetings, tasks and events" },
  { value: "team", label: "Team", description: "A team's events, meetings and deadlines" },
  { value: "organization", label: "Organization", description: "Company-wide events and project deadlines" },
];

/** Legend categories. `scopes` = where each is meaningful (the organization calendar leaves out individual tasks). */
export const CATEGORIES = [
  { value: "general", label: "Events", dot: "bg-sky-500", chip: "border-sky-500/30 bg-sky-500/15 text-sky-800 dark:text-sky-200", scopes: ["personal", "team"] },
  { value: "team", label: "Team events", dot: "bg-emerald-500", chip: "border-emerald-500/30 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200", scopes: ["personal", "team"] },
  { value: "organization", label: "Organization", dot: "bg-violet-500", chip: "border-violet-500/30 bg-violet-500/15 text-violet-800 dark:text-violet-200", scopes: ["personal", "team", "organization"] },
  { value: "personal", label: "Personal", dot: "bg-amber-500", chip: "border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-200", scopes: ["personal"] },
  { value: "meeting", label: "Meetings", dot: "bg-indigo-500", chip: "border-indigo-500/30 bg-indigo-500/15 text-indigo-800 dark:text-indigo-200", scopes: ["personal", "team", "organization"] },
  { value: "task", label: "Task deadlines", dot: "bg-rose-500", chip: "border-rose-500/30 bg-rose-500/15 text-rose-800 dark:text-rose-200", scopes: ["personal", "team"] },
  { value: "project", label: "Project deadlines", dot: "bg-orange-500", chip: "border-orange-500/30 bg-orange-500/15 text-orange-800 dark:text-orange-200", scopes: ["personal", "team", "organization"] },
];

export const CATEGORY_BY_VALUE = Object.fromEntries(CATEGORIES.map((category) => [category.value, category]));
export const categoriesForScope = (scope) => CATEGORIES.filter((category) => category.scopes.includes(scope));

export const EVENT_TYPE_OPTIONS = [
  { value: "personal", label: "Personal", description: "Only you and the people you invite" },
  { value: "general", label: "General", description: "An event with invitees, optionally for a project" },
  { value: "team", label: "Team event", description: "Everyone on a team you manage" },
  { value: "organization", label: "Organization event", description: "Everyone in the organization" },
];

export const REMINDER_PRESETS = [
  { value: 5, label: "5 minutes before" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 1440, label: "1 day before" },
];
export const MAX_REMINDERS = 5;

export const WEEK_START_OPTIONS = [
  { value: 1, label: "Monday" },
  { value: 0, label: "Sunday" },
  { value: 6, label: "Saturday" },
];

export function reminderLabel(minutes) {
  const preset = REMINDER_PRESETS.find((item) => item.value === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

const ORDINALS = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every 2 weeks on Mon, Thu until Mar 30" — a readable summary of a recurrence rule. */
export function describeRecurrence(rule) {
  if (!rule) return "Does not repeat";
  const n = rule.interval || 1;
  let text;
  if (rule.freq === "daily") text = n === 1 ? "Every day" : `Every ${n} days`;
  else if (rule.freq === "weekly") {
    const days = (rule.byWeekday || []).map((d) => WEEKDAYS[d].slice(0, 3)).join(", ");
    text = `${n === 1 ? "Every week" : `Every ${n} weeks`}${days ? ` on ${days}` : ""}`;
  } else {
    const base = n === 1 ? "Every month" : `Every ${n} months`;
    text = rule.monthly?.mode === "nthWeekday"
      ? `${base} on the ${ORDINALS[rule.monthly.nth]} ${WEEKDAYS[rule.monthly.weekday]}`
      : `${base} on day ${rule.monthly?.day ?? ""}`.trim();
  }
  if (rule.count) text += `, ${rule.count} times`;
  else if (rule.untilLocal) text += `, until ${rule.untilLocal}`;
  return text;
}

// Used until the user's saved timezone has loaded; matches the backend default (India Standard Time).
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
