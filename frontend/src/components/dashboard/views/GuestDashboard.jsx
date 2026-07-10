"use client";

import { FileText, CalendarClock, ListTodo } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import KpiRow from "@/components/dashboard/KpiRow";
import RecentActivityFeed from "@/components/dashboard/RecentActivityFeed";
import LatestDocumentsCard from "@/components/dashboard/LatestDocumentsCard";
import UpcomingMeetingsCard from "@/components/dashboard/UpcomingMeetingsCard";
import AnnouncementsCard from "@/components/dashboard/AnnouncementsCard";
import { LATEST_DOCUMENTS, MOCK_MEETINGS, ANNOUNCEMENTS, PREVIEW_ACTIVITY } from "@/components/dashboard/mockDashboardData";

export default function GuestDashboard() {
  const user = useAuthStore((state) => state.user);

  const kpiCards = [
    { label: "Accessible documents", value: LATEST_DOCUMENTS.length, icon: FileText, accent: "from-sky-500 to-blue-600" },
    { label: "Meetings", value: MOCK_MEETINGS.length, icon: CalendarClock, accent: "from-violet-500 to-indigo-600" },
    { label: "Tasks assigned", value: 2, icon: ListTodo, accent: "from-emerald-500 to-teal-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Welcome{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}.
        </h1>
        <p className="mt-1.5 text-[0.95rem] text-zinc-500">You have read-only access to this workspace.</p>
      </div>

      <KpiRow items={kpiCards} />

      <div className="grid gap-6 lg:grid-cols-2">
        <LatestDocumentsCard documents={LATEST_DOCUMENTS} title="Shared documents" />
        <UpcomingMeetingsCard meetings={MOCK_MEETINGS} />
      </div>

      <AnnouncementsCard announcements={ANNOUNCEMENTS} />

      <RecentActivityFeed logs={PREVIEW_ACTIVITY} />
    </div>
  );
}
