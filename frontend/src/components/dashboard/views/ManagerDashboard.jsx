"use client";

import { useMemo } from "react";
import { FolderKanban, ListChecks, Users, CalendarClock } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import ProjectsOverviewCard from "@/components/dashboard/ProjectsOverviewCard";
import TeamWorkloadCard from "@/components/dashboard/TeamWorkloadCard";
import TeamSnapshotCard from "@/components/dashboard/TeamSnapshotCard";
import UpcomingMeetingsCard from "@/components/dashboard/UpcomingMeetingsCard";
import OverdueTasksCard from "@/components/dashboard/OverdueTasksCard";
import {
  MOCK_PROJECTS,
  TASK_STATUS_BREAKDOWN,
  TEAM_WORKLOAD,
  MOCK_MEETINGS,
  OVERDUE_TASKS,
  PREVIEW_ACTIVITY,
  aiInsightsFor,
} from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "Create project", href: "/dashboard/projects/new", icon: FolderKanban, accent: "from-violet-500 to-indigo-600" },
  { label: "Assign task", href: "/dashboard/tasks/new", icon: ListChecks, accent: "from-emerald-500 to-teal-600" },
  { label: "Team", href: "/dashboard/people", icon: Users, accent: "from-amber-500 to-orange-600" },
  { label: "Schedule meeting", href: "/dashboard/meetings/new", icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
];

export default function ManagerDashboard() {
  const user = useAuthStore((state) => state.user);

  const openTasks = useMemo(
    () => TASK_STATUS_BREAKDOWN.filter((item) => item.name !== "Done").reduce((sum, item) => sum + item.value, 0),
    []
  );

  const kpiCards = [
    { label: "Active projects", value: 4, icon: FolderKanban, accent: "from-violet-500 to-indigo-600" },
    { label: "Open tasks", value: openTasks, icon: ListChecks, accent: "from-emerald-500 to-teal-600" },
    { label: "Team members", value: 9, icon: Users, accent: "from-amber-500 to-orange-600" },
    { label: "Due this week", value: 6, icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Welcome back{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
        </h1>
        <p className="mt-1.5 text-[0.95rem] text-zinc-500">Here's where your team stands today.</p>
      </div>

      <KpiStrip items={kpiCards} />

      <QuickActionsCard actions={QUICK_ACTIONS} size="sm" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TeamWorkloadCard workload={TEAM_WORKLOAD} />
        </div>
        <AIInsightsCard insights={aiInsightsFor("manager")} />
      </div>

      <ProjectsOverviewCard projects={MOCK_PROJECTS} />

      <div className="grid gap-6 lg:grid-cols-2">
        <TeamSnapshotCard />
        <UpcomingMeetingsCard meetings={MOCK_MEETINGS} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <OverdueTasksCard tasks={OVERDUE_TASKS} />
        <RecentActivityFeed logs={PREVIEW_ACTIVITY} />
      </div>
    </div>
  );
}
