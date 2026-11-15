"use client";

import { ListTodo, CheckCheck, CalendarClock, FileText, AlertTriangle } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import { DeadlinesCard, MyMeetingsRealCard, MyProjectsRealCard, TaskTrendCard, kpi, useDashboardAnalytics } from "@/components/dashboard/AnalyticsWidgets";
import PinnedItemsButton from "@/components/dashboard/PinnedItemsButton";
import MyTeamButton from "@/components/dashboard/MyTeamButton";
import { PINNED_ITEMS, MY_TEAM, aiInsightsFor } from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "My tasks", href: "/dashboard/tasks", icon: ListTodo, accent: "from-violet-500 to-indigo-600" },
  { label: "Join meeting", href: "/dashboard/meetings", icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
  { label: "My projects", href: "/dashboard/projects", icon: FileText, accent: "from-emerald-500 to-teal-600" },
];

export default function EmployeeDashboard() {
  const user = useAuthStore((state) => state.user);
  const me = useDashboardAnalytics("me");
  const data = me.data;

  const kpiCards = [
    { label: "My open tasks", value: kpi(me, data?.kpis.open), icon: ListTodo, accent: "from-violet-500 to-indigo-600" },
    { label: "Completed (30 days)", value: kpi(me, data?.kpis.completedInRange), icon: CheckCheck, accent: "from-emerald-500 to-teal-600" },
    { label: "Overdue", value: kpi(me, data?.kpis.overdue), icon: AlertTriangle, accent: "from-rose-500 to-red-600" },
    { label: "Meetings (30 days)", value: kpi(me, data?.kpis.meetings), icon: CalendarClock, accent: "from-sky-500 to-blue-600" },
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
          <DeadlinesCard upcoming={data?.lists.upcomingDeadlines} overdue={data?.lists.overdueTasks} loading={me.isLoading} />
        </div>
        <AIInsightsCard title="AI Assistant" insights={aiInsightsFor("employee")} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <MyMeetingsRealCard meetings={data?.lists.upcomingMeetings} loading={me.isLoading} />
        <MyProjectsRealCard projects={data?.lists.projects} loading={me.isLoading} />
      </div>
      <TaskTrendCard series={data?.series.createdVsCompleted} loading={me.isLoading} title="My tasks created vs completed" />
    </div>
  );
}
