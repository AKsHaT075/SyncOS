import {
  LayoutDashboard,
  FolderKanban,
  CheckSquare,
  Target,
  Users,
  Users2,
  Video,
  Calendar,
  FileText,
  Box,
  FileBarChart,
  LineChart,
  Sparkles,
  Settings,
  CheckCircle2,
  Bell,
} from "lucide-react";
import { PERMISSIONS } from "@/constants/permissions";

/**
 * permission: null means visible to every authenticated user.
 * Backend has no dedicated "view" permission for some resources yet
 * (Projects, Teams, Calendar, Goals, Settings) — those default to null
 * until the corresponding PERMISSIONS entries exist.
 *
 * Items are grouped into sections so the sidebar reads as a schema of the
 * product rather than one long flat list.
 */
export const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: null },
    ],
  },
  {
    label: "Work",
    items: [
      { label: "Projects", href: "/dashboard/projects", icon: FolderKanban, permission: null },
      { label: "Tasks", href: "/dashboard/tasks", icon: CheckSquare, permission: PERMISSIONS.VIEW_TASK },
      { label: "Goals", href: "/dashboard/goals", icon: Target, permission: null },
    ],
  },
  {
    label: "People",
    items: [
      { label: "People", href: "/dashboard/people", icon: Users, permission: PERMISSIONS.MANAGE_USERS },
      { label: "Teams", href: "/dashboard/teams", icon: Users2, permission: PERMISSIONS.UPDATE_TEAM },
    ],
  },
  {
    label: "Collaborate",
    items: [
      { label: "Meetings", href: "/dashboard/meetings", icon: Video, permission: PERMISSIONS.VIEW_MEETING },
      { label: "Calendar", href: "/dashboard/calendar", icon: Calendar, permission: null },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Documents", href: "/dashboard/documents", icon: FileText, permission: PERMISSIONS.VIEW_DOCUMENT },
      { label: "Assets", href: "/dashboard/assets", icon: Box, permission: PERMISSIONS.MANAGE_ASSETS },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Reports", href: "/dashboard/reports", icon: FileBarChart, permission: PERMISSIONS.VIEW_ANALYTICS },
      { label: "Analytics", href: "/dashboard/analytics", icon: LineChart, permission: PERMISSIONS.VIEW_ANALYTICS },
    ],
  },
  {
    label: "Automation",
    items: [
      { label: "AI Studio", href: "/dashboard/ai-studio", icon: Sparkles, permission: PERMISSIONS.MANAGE_AI },
    ],
  },
];

// Flat list kept for consumers that don't need the grouping (command palette, search).
export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export const SETTINGS_ITEM = { label: "Settings", href: "/dashboard/settings", icon: Settings, permission: null };

// Shown above the main menu. No badge count is wired for "My Tasks" — there's
// no Tasks feature yet to source a real number from.
export const QUICK_LINKS = [
  { label: "My Tasks", href: "/dashboard/mytask", icon: CheckCircle2, permission: null },
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell, permission: null },
];
