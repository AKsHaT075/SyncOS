"use client";

import { ListTodo, CheckCheck, CalendarClock, FileText } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import TodaysTasksCard from "@/components/dashboard/TodaysTasksCard";
import UpcomingMeetingsCard from "@/components/dashboard/UpcomingMeetingsCard";
import MyProjectsCard from "@/components/dashboard/MyProjectsCard";
import PinnedItemsButton from "@/components/dashboard/PinnedItemsButton";
import MyTeamButton from "@/components/dashboard/MyTeamButton";
import { TODAYS_TASKS, MOCK_MEETINGS, MY_PROJECTS, LATEST_DOCUMENTS, PINNED_ITEMS, MY_TEAM, aiInsightsFor } from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "Log a task", href: "/dashboard/tasks/new", icon: ListTodo, accent: "from-violet-500 to-indigo-600" },
  { label: "Join meeting", href: "/dashboard/meetings", icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
  { label: "My projects", href: "/dashboard/projects", icon: FileText, accent: "from-emerald-500 to-teal-600" },
];

export default function EmployeeDashboard() {
  const user = useAuthStore((state) => state.user);
  const tasksToday = TODAYS_TASKS.filter((task) => !task.done).length;
  const completedThisWeek = TODAYS_TASKS.filter((task) => task.done).length + 5;
  const meetingsToday = MOCK_MEETINGS.filter((meeting) => meeting.group === "today").length;

  const kpiCards = [
    { label: "My tasks", value: tasksToday, icon: ListTodo, accent: "from-violet-500 to-indigo-600" },
    { label: "Completed this week", value: completedThisWeek, icon: CheckCheck, accent: "from-emerald-500 to-teal-600" },
    { label: "Meetings today", value: meetingsToday, icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
    { label: "Shared documents", value: LATEST_DOCUMENTS.length, icon: FileText, accent: "from-amber-500 to-orange-600" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
            Welcome back{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
          </h1>
          <p className="mt-1.5 text-[0.95rem] text-zinc-500">Here's what's on your plate today.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MyTeamButton members={MY_TEAM} />
          <PinnedItemsButton items={PINNED_ITEMS} />
        </div>
      </div>

      <KpiStrip items={kpiCards} />

      <QuickActionsCard actions={QUICK_ACTIONS} size="sm" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodaysTasksCard tasks={TODAYS_TASKS} />
        </div>
        <AIInsightsCard title="AI Assistant" insights={aiInsightsFor("employee")} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <UpcomingMeetingsCard meetings={MOCK_MEETINGS} />
        <MyProjectsCard projects={MY_PROJECTS} />
      </div>
    </div>
  );
}
