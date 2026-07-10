import { Database } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

function barColor(pct) {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-sky-500";
}

export default function ResourceUsageCard({ storage, aiCredits }) {
  const rows = [
    { label: "Storage", used: storage.used, total: storage.total, unit: storage.unit },
    { label: "AI credits", used: aiCredits.used, total: aiCredits.total, unit: aiCredits.unit },
  ];

  return (
    <DashboardCard>
      <DashboardCardHeader icon={Database} iconClassName="bg-sky-50 text-sky-600" title="Resource usage" preview />

      <div className="mt-3 space-y-3">
        {rows.map((row) => {
          const pct = Math.min(100, Math.round((row.used / row.total) * 100));
          return (
            <div key={row.label}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{row.label}</span>
                <span className="font-medium text-zinc-900">
                  {row.used} / {row.total} {row.unit}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}
