import { Activity } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

export default function PlatformHealthCard({ stats }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Activity}
        iconClassName="bg-sky-50 text-sky-600"
        title="Platform health"
        description="API, queue, and infrastructure status."
        preview
      />

      <div className="mt-4 grid grid-cols-2 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-zinc-100 p-3">
            <div className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${stat.healthy ? "bg-emerald-500" : "bg-red-500"}`} />
              <p className="text-xs text-zinc-500">{stat.label}</p>
            </div>
            <p className="mt-1.5 text-lg font-bold text-zinc-900">{stat.value}</p>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
