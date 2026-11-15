"use client";

import { FolderKanban, ListChecks, Users, CalendarClock } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import { ProjectProgressCard, TaskTrendCard, WorkloadCard, kpi, useDashboardAnalytics } from "@/components/dashboard/AnalyticsWidgets";
import TeamSnapshotCard from "@/components/dashboard/TeamSnapshotCard";
import { LiveUpcomingMeetingsCard } from "@/components/dashboard/LiveWidgets";
import {
  PREVIEW_ACTIVITY,
  aiInsightsFor,
} from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "Create project", href: "/dashboard/projects/new", icon: FolderKanban, accent: "from-violet-500 to-indigo-600" },
  { label: "Assign task", href: "/dashboard/projects", icon: ListChecks, accent: "from-emerald-500 to-teal-600" },
  { label: "Team", href: "/dashboard/people", icon: Users, accent: "from-amber-500 to-orange-600" },
  { label: "Schedule meeting", href: "/dashboard/meetings", icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
];

export default function ManagerDashboard() {
  const user = useAuthStore((state) => state.user);

  const overview = useDashboardAnalytics("overview");
  const sections = overview.data?.sections;

  const kpiCards = [
    { label: "Team projects", value: kpi(overview, sections?.projects.kpis.total), icon: FolderKanban, accent: "from-violet-500 to-indigo-600" },
    { label: "Open tasks", value: kpi(overview, sections?.tasks.kpis.open), icon: ListChecks, accent: "from-emerald-500 to-teal-600" },
    { label: "Team members", value: kpi(overview, sections?.people.kpis.members), icon: Users, accent: "from-amber-500 to-orange-600" },
    { label: "Overdue tasks", value: kpi(overview, sections?.tasks.kpis.overdue), icon: CalendarClock, accent: "from-rose-500 to-red-600" },
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
          <WorkloadCard rows={sections?.people.breakdowns.workload} loading={overview.isLoading} title="Team workload" description="Open tasks per team member. Counts only, not performance." />
        </div>
        <AIInsightsCard insights={aiInsightsFor("manager")} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TaskTrendCard series={sections?.tasks.series.createdVsCompleted} loading={overview.isLoading} title="Team tasks created vs completed" />
        <ProjectProgressCard data={sections?.projects} loading={overview.isLoading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TeamSnapshotCard />
        <LiveUpcomingMeetingsCard />
      </div>

      <RecentActivityFeed logs={PREVIEW_ACTIVITY} />
    </div>
  );
}
