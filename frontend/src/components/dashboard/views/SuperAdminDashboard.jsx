"use client";

import { Building2, Users, CreditCard, Database, LogIn } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { useOrganizations } from "@/features/platform/hooks/useOrganizations";
import KpiRow from "@/components/dashboard/KpiRow";
import QuickActionsCard from "@/components/dashboard/QuickActionsCard";
import OrganizationsTableCard from "@/components/dashboard/OrganizationsTableCard";
import RecentlyCreatedOrganizationsCard from "@/components/dashboard/RecentlyCreatedOrganizationsCard";
import PlatformHealthCard from "@/components/dashboard/PlatformHealthCard";
import FeatureFlagsCard from "@/components/dashboard/FeatureFlagsCard";
import { PlatformGrowthCard, kpi } from "@/components/dashboard/AnalyticsWidgets";
import { usePlatformAnalytics } from "@/features/analytics/hooks/analyticsHooks";
import { presetRange } from "@/features/analytics/utils/format";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import { PLATFORM_HEALTH_STATS, GLOBAL_FEATURE_FLAGS, PREVIEW_ACTIVITY } from "@/components/dashboard/mockDashboardData";
import { toast } from "sonner";

function describeQuickAction(action) {
  toast.info(`Pick an organization from the table below to ${action}.`);
}

const QUICK_ACTIONS = [
  { label: "Suspend organization", icon: Building2, accent: "from-red-500 to-rose-600", onClick: () => describeQuickAction("suspend it") },
  { label: "Change plan", icon: CreditCard, accent: "from-violet-500 to-indigo-600", onClick: () => describeQuickAction("change its plan") },
  { label: "Enable feature flag", icon: Database, accent: "from-emerald-500 to-teal-600", onClick: () => describeQuickAction("toggle a feature flag for it") },
];

export default function SuperAdminDashboard() {
  const user = useAuthStore((state) => state.user);
  const { data, isLoading } = useOrganizations({ limit: 50 });
  const organizations = data?.organizations ?? [];

  const platform = usePlatformAnalytics(presetRange("30"));
  const k = platform.data?.kpis;

  const kpiCards = [
    { label: "Organizations", value: kpi(platform, k?.organizations), icon: Building2, accent: "from-violet-500 to-indigo-600" },
    { label: "Users", value: kpi(platform, k?.users), icon: Users, accent: "from-emerald-500 to-teal-600" },
    { label: "New organizations (30 days)", value: kpi(platform, k?.newOrganizations), icon: CreditCard, accent: "from-amber-500 to-orange-600" },
    { label: "Sign-ins (30 days)", value: kpi(platform, k?.logins), icon: LogIn, accent: "from-sky-500 to-blue-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Welcome back{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
        </h1>
        <p className="mt-1.5 text-[0.95rem] text-zinc-500">Platform-wide overview. No tenant data is shown here.</p>
      </div>

      <KpiRow items={kpiCards} />

      <OrganizationsTableCard organizations={organizations} isLoading={isLoading} />

      <div className="grid gap-6 lg:grid-cols-2">
        <RecentlyCreatedOrganizationsCard organizations={organizations} isLoading={isLoading} />
        <PlatformHealthCard stats={PLATFORM_HEALTH_STATS} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <PlatformGrowthCard series={platform.data?.series.organizationGrowth.map((point, i) => ({ ...point, users: platform.data.series.userGrowth[i]?.users ?? 0 }))} loading={platform.isLoading} />
        <FeatureFlagsCard flags={GLOBAL_FEATURE_FLAGS} />
      </div>

      <RecentActivityFeed logs={PREVIEW_ACTIVITY} />

      <QuickActionsCard actions={QUICK_ACTIONS} />
    </div>
  );
}
