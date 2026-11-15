"use client";

import { useAuthStore } from "@/store/useAuthStore";
import { RestrictedAnalyticsCard } from "@/components/dashboard/AnalyticsWidgets";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import { LiveLatestDocumentsCard, LiveUpcomingMeetingsCard } from "@/components/dashboard/LiveWidgets";
import AnnouncementsCard from "@/components/dashboard/AnnouncementsCard";
import { ANNOUNCEMENTS, PREVIEW_ACTIVITY } from "@/components/dashboard/mockDashboardData";

export default function GuestDashboard() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Welcome{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
        </h1>
        <p className="mt-1.5 text-[0.95rem] text-zinc-500">You have read-only access to this workspace.</p>
      </div>

      <RestrictedAnalyticsCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <LiveLatestDocumentsCard title="Shared documents" />
        <LiveUpcomingMeetingsCard />
      </div>

      <AnnouncementsCard announcements={ANNOUNCEMENTS} />

      <RecentActivityFeed logs={PREVIEW_ACTIVITY} />
    </div>
  );
}
