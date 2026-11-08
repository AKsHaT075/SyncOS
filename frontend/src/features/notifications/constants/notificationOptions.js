import {
  Bell,
  Box,
  Calendar,
  CalendarDays,
  CheckSquare,
  FileText,
  FolderKanban,
  ShieldAlert,
  UserCog,
  Users2,
  Video,
} from "lucide-react";

// Mirrors backend/src/constants/notification.constants.js
export const CATEGORIES = [
  { value: "task", label: "Tasks", description: "Assignments, reviews, approvals and completion", email: true },
  { value: "project", label: "Projects", description: "Membership, ownership, archiving and deletion", email: false },
  { value: "meeting", label: "Meetings", description: "Invitations, changes, cancellations, requests and reminders", email: true },
  { value: "team", label: "People & teams", description: "Team membership, managers and role changes", email: true },
  { value: "document", label: "Documents", description: "Sharing, access changes and new versions", email: true },
  { value: "calendar", label: "Calendar", description: "Event invitations, changes, cancellations and reminders", email: true },
  { value: "asset", label: "Assets", description: "Assignments, return requests, maintenance and warranty or license expiry", email: true },
];

export const CATEGORY_FILTERS = [...CATEGORIES, { value: "security", label: "Security" }];

export const CATEGORY_LABELS = Object.fromEntries(CATEGORY_FILTERS.map((category) => [category.value, category.label]));

/** Icon + colour per notification type prefix (falls back to category, then a bell). */
const BY_PREFIX = {
  task: { icon: CheckSquare, tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  project: { icon: FolderKanban, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  meeting: { icon: Video, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  meeting_request: { icon: Calendar, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  team: { icon: Users2, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  person: { icon: UserCog, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  document: { icon: FileText, tone: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  calendar: { icon: CalendarDays, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  asset: { icon: Box, tone: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  security: { icon: ShieldAlert, tone: "bg-red-500/10 text-red-600 dark:text-red-400" },
};

export function notificationVisual(type) {
  const prefix = String(type || "").split(".")[0];
  return BY_PREFIX[prefix] ?? { icon: Bell, tone: "bg-muted text-muted-foreground" };
}

export const UNREAD_CAP = 100;
export const POPOVER_LIMIT = 8;
export const PAGE_LIMIT = 20;
