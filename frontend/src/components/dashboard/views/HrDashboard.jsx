"use client";

import { Users, UserPlus2, Mail, Briefcase } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiStrip from "@/components/dashboard/KpiStrip";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import AIInsightsCard from "@/components/dashboard/AIInsightsCard";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import EmployeeDistributionCard from "@/components/dashboard/EmployeeDistributionCard";
import RecentlyJoinedMembersCard from "@/components/dashboard/RecentlyJoinedMembersCard";
import PendingInvitationsCard from "@/components/dashboard/PendingInvitationsCard";
import UpcomingBirthdaysCard from "@/components/dashboard/UpcomingBirthdaysCard";
import OnboardingStatusCard from "@/components/dashboard/OnboardingStatusCard";
import {
  DEPARTMENTS,
  RECENTLY_JOINED,
  PREVIEW_INVITATIONS,
  UPCOMING_BIRTHDAYS,
  NEW_HIRES,
  PREVIEW_ACTIVITY,
  aiInsightsFor,
} from "@/components/dashboard/mockDashboardData";

const QUICK_ACTIONS = [
  { label: "Invite employee", href: "/dashboard/people/invite", icon: UserPlus2, accent: "from-violet-500 to-indigo-600" },
  { label: "Review onboarding", href: "/dashboard/people/onboarding", icon: Briefcase, accent: "from-emerald-500 to-teal-600" },
  { label: "Manage people", href: "/dashboard/people", icon: Users, accent: "from-amber-500 to-orange-600" },
  { label: "Pending invites", href: "/dashboard/people/invitations", icon: Mail, accent: "from-sky-500 to-blue-600" },
];

export default function HrDashboard() {
  const user = useAuthStore((state) => state.user);
  const headcount = DEPARTMENTS.reduce((sum, item) => sum + item.value, 0);

  const kpiCards = [
    { label: "Employees", value: headcount, icon: Users, accent: "from-violet-500 to-indigo-600" },
    { label: "New hires", value: NEW_HIRES.length, icon: UserPlus2, accent: "from-emerald-500 to-teal-600" },
    { label: "Pending invitations", value: PREVIEW_INVITATIONS.length, icon: Mail, accent: "from-amber-500 to-orange-600" },
    { label: "Open positions", value: 4, icon: Briefcase, accent: "from-sky-500 to-blue-600" },
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
          <EmployeeDistributionCard departments={DEPARTMENTS} />
        </div>
        <AIInsightsCard insights={aiInsightsFor("hr")} />
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
