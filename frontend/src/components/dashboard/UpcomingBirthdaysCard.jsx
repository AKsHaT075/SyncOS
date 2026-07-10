import { Cake } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function UpcomingBirthdaysCard({ birthdays }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Cake}
        iconClassName="bg-rose-50 text-rose-600"
        title="Upcoming birthdays"
        description="This month."
        preview
      />

      <div className="mt-4 space-y-1">
        {birthdays.length === 0 ? (
          <EmptyStateCard icon={Cake} title="No birthdays this month" />
        ) : (
          birthdays.map((person) => (
            <div key={person.id} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-zinc-50">
              <span className="text-sm font-medium text-zinc-900">{person.name}</span>
              <span className="text-xs text-zinc-500">{person.date}</span>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
