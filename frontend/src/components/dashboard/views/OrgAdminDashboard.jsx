"use client";

import { useMemo } from "react";
import { Mail, FolderKanban, ListChecks, CheckCheck, UserPlus, Users2, CalendarClock, FileUp } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { usePendingInvitations } from "@/features/invitations/hooks/usePendingInvitations";
import { useResendInvitation } from "@/features/invitations/hooks/useResendInvitation";
import { useRecentActivity } from "@/features/audit/hooks/useRecentActivity";
import InviteTeammateDialog from "@/components/dashboard/InviteTeammateDialog";
import WorkspaceUsageStrip from "@/components/dashboard/WorkspaceUsageStrip";
import TeamSnapshotCard from "@/components/dashboard/TeamSnapshotCard";
import SecuritySnapshotCard from "@/components/dashboard/SecuritySnapshotCard";
import ResourceUsageCard from "@/components/dashboard/ResourceUsageCard";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import ActivityOverviewCard from "@/components/dashboard/ActivityOverviewCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import OrgHealthRing from "@/components/dashboard/OrgHealthRing";
import RecentlyJoinedMembersCard from "@/components/dashboard/RecentlyJoinedMembersCard";
import PendingInvitationsCard from "@/components/dashboard/PendingInvitationsCard";
import { LiveLatestDocumentsCard, LiveUpcomingMeetingsCard } from "@/components/dashboard/LiveWidgets";
import { ProjectProgressCard, TaskTrendCard, kpi, useDashboardAnalytics } from "@/components/dashboard/AnalyticsWidgets";
import {
  RECENTLY_JOINED,
  HEALTH_BREAKDOWN,
  aiInsightsFor,
} from "@/components/dashboard/mockDashboardData";

function formatRelativeTime(dateInput) {
  const date = new Date(dateInput);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const QUICK_ACTIONS = [
  { label: "Invite member", href: "/dashboard/people", icon: UserPlus, accent: "from-violet-500 to-indigo-600" },
  { label: "Create project", href: "/dashboard/projects/new", icon: FolderKanban, accent: "from-emerald-500 to-teal-600" },
  { label: "Create team", href: "/dashboard/teams", icon: Users2, accent: "from-amber-500 to-orange-600" },
  { label: "Upload document", href: "/dashboard/documents", icon: FileUp, accent: "from-sky-500 to-blue-600" },
  { label: "Schedule meeting", href: "/dashboard/meetings", icon: CalendarClock, accent: "from-rose-500 to-pink-600" },
];

function buildActivityTrend(logs) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    days.push({ key: day.toDateString(), label: day.toLocaleDateString(undefined, { weekday: "short" }), count: 0 });
  }

  const byKey = new Map(days.map((day) => [day.key, day]));
  logs.forEach((log) => {
    const key = new Date(log.createdAt).toDateString();
    const bucket = byKey.get(key);
    if (bucket) bucket.count += 1;
  });

  return days;
}

export default function OrgAdminDashboard() {
  const user = useAuthStore((state) => state.user);
  const organizationDetails = useAuthStore((state) => state.organizationDetails);

  const { data: invitationsData, isLoading: invitationsLoading } = usePendingInvitations({ limit: 5 });
  const { data: activityData, isLoading: activityLoading } = useRecentActivity({ limit: 50 });
  const resendInvitation = useResendInvitation();

  const pendingInvitations = invitationsData?.invitations ?? [];
  const pendingCount = invitationsData?.pagination?.total ?? 0;
  const activityLogs = activityData?.logs ?? [];

  const activityTrend = useMemo(() => buildActivityTrend(activityLogs), [activityLogs]);
  const overview = useDashboardAnalytics("overview");
  const sections = overview.data?.sections;

  const workspaceAge = organizationDetails?.createdAt ? formatRelativeTime(organizationDetails.createdAt) : "—";
  const seatsLimit = organizationDetails?.limits?.seats;

  const kpiCards = [
    { label: "Active projects", value: kpi(overview, sections?.projects.kpis.active), icon: FolderKanban, accent: "from-violet-500 to-indigo-600" },
    { label: "Open tasks", value: kpi(overview, sections?.tasks.kpis.open), icon: ListChecks, accent: "from-emerald-500 to-teal-600" },
    { label: "Completed (30 days)", value: kpi(overview, sections?.tasks.kpis.completedInRange), icon: CheckCheck, accent: "from-sky-500 to-blue-600" },
    { label: "Pending invites", value: invitationsLoading ? "…" : pendingCount, icon: Mail, accent: "from-amber-500 to-orange-600" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
            Welcome back{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
          </h1>
          <p className="mt-1.5 text-[0.95rem] text-zinc-500">
            Here's what's happening in {organizationDetails?.name ?? "your workspace"} today.
          </p>
        </div>
        <InviteTeammateDialog>
          <button
            type="button"
            className="flex items-center gap-2 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-violet-500/30 transition-all hover:shadow-md"
          >
            <UserPlus className="size-4" />
            Invite teammate
          </button>
        </InviteTeammateDialog>
      </div>

      <WorkspaceUsageStrip
        plan={organizationDetails?.plan ?? "free"}
        seatsUsed={sections?.people.kpis.members ?? 0}
        seatsLimit={seatsLimit}
        workspaceAge={workspaceAge}
      />

      <KpiStrip items={kpiCards} />

      <QuickActionsCard actions={QUICK_ACTIONS} size="sm" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <TeamSnapshotCard />
          <ResourceUsageCard />
        </div>
        <div className="space-y-5">
          <OrgHealthRing overall={79} breakdown={HEALTH_BREAKDOWN} />
          <AIInsightsCard insights={aiInsightsFor("org-admin")} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <TaskTrendCard series={sections?.tasks.series.createdVsCompleted} loading={overview.isLoading} />
        <ProjectProgressCard data={sections?.projects} loading={overview.isLoading} />
      </div>

      <ActivityOverviewCard
        trend={activityTrend}
        logs={activityLogs}
        isLoading={activityLoading}
        eventCount={activityLogs.length}
      />

      <SecuritySnapshotCard />

      <div className="grid gap-5 sm:grid-cols-2">
        <LiveLatestDocumentsCard />
        <RecentlyJoinedMembersCard members={RECENTLY_JOINED} />
        <PendingInvitationsCard
          invitations={pendingInvitations}
          isLoading={invitationsLoading}
          onResend={(id) => resendInvitation.mutate(id)}
          isResending={resendInvitation.isPending}
        />
        <LiveUpcomingMeetingsCard />
      </div>
    </div>
  );
}
