"use client";

import { Users, UserPlus2, Briefcase, ListChecks, AlertTriangle } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import { TaskTrendCard, TeamSizeCard, WorkloadCard, kpi, useDashboardAnalytics } from "@/components/dashboard/AnalyticsWidgets";
import RecentlyJoinedMembersCard from "@/components/dashboard/RecentlyJoinedMembersCard";
import PendingInvitationsCard from "@/components/dashboard/PendingInvitationsCard";
import UpcomingBirthdaysCard from "@/components/dashboard/UpcomingBirthdaysCard";
import OnboardingStatusCard from "@/components/dashboard/OnboardingStatusCard";
import {
  RECENTLY_JOINED,
  PREVIEW_INVITATIONS,
  UPCOMING_BIRTHDAYS,
  NEW_HIRES,
  PREVIEW_ACTIVITY,
  aiInsightsFor,
} from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "People directory", href: "/dashboard/people", icon: Users, accent: "from-amber-500 to-orange-600" },
  { label: "Teams", href: "/dashboard/teams", icon: Briefcase, accent: "from-emerald-500 to-teal-600" },
  { label: "Reports", href: "/dashboard/reports", icon: ListChecks, accent: "from-sky-500 to-blue-600" },
];

export default function HrDashboard() {
  const user = useAuthStore((state) => state.user);
  const overview = useDashboardAnalytics("overview");
  const sections = overview.data?.sections;

  const kpiCards = [
    { label: "Employees", value: kpi(overview, sections?.people.kpis.members), icon: Users, accent: "from-violet-500 to-indigo-600" },
    { label: "Joined (30 days)", value: kpi(overview, sections?.people.kpis.newInRange), icon: UserPlus2, accent: "from-emerald-500 to-teal-600" },
    { label: "People with open work", value: kpi(overview, sections?.people.kpis.withOpenTasks), icon: ListChecks, accent: "from-sky-500 to-blue-600" },
    { label: "Overdue tasks", value: kpi(overview, sections?.tasks.kpis.overdue), icon: AlertTriangle, accent: "from-rose-500 to-red-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Welcome back{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
        </h1>
        <p className="mt-1.5 text-[0.95rem] text-zinc-500">Here's how your people are doing today.</p>
      </div>

      <KpiStrip items={kpiCards} />

      <QuickActionsCard actions={QUICK_ACTIONS} size="sm" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TeamSizeCard rows={sections?.people.breakdowns.byTeam} loading={overview.isLoading} />
        </div>
        <AIInsightsCard insights={aiInsightsFor("hr")} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <WorkloadCard rows={sections?.people.breakdowns.workload} loading={overview.isLoading} />
        <TaskTrendCard series={sections?.tasks.series.createdVsCompleted} loading={overview.isLoading} title="Tasks created vs completed" description="Organization-wide counts, last 30 days." />
      </div>

      <OnboardingStatusCard hires={NEW_HIRES} />

      <div className="grid gap-6 lg:grid-cols-2">
        <RecentlyJoinedMembersCard members={RECENTLY_JOINED} />
        <PendingInvitationsCard invitations={PREVIEW_INVITATIONS} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <UpcomingBirthdaysCard birthdays={UPCOMING_BIRTHDAYS} />
        <RecentActivityFeed logs={PREVIEW_ACTIVITY} />
      </div>
    </div>
  );
}
