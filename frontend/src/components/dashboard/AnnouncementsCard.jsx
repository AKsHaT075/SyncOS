import { Megaphone } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function AnnouncementsCard({ announcements }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Megaphone}
        iconClassName="bg-violet-50 text-violet-600"
        title="Announcements"
        description="Shared with you by the workspace."
        preview
      />

      <div className="mt-4 space-y-3">
        {announcements.length === 0 ? (
          <EmptyStateCard icon={Megaphone} title="No announcements" />
        ) : (
          announcements.map((item) => (
            <div key={item.id} className="rounded-xl border border-zinc-100 p-3">
              <p className="text-sm font-medium text-zinc-900">{item.title}</p>
              <p className="mt-0.5 text-xs text-zinc-500">{item.postedAt}</p>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
