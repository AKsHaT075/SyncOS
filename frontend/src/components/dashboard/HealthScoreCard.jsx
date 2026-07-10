import { HeartPulse } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

function scoreColor(score) {
  if (score >= 80) return "text-emerald-600";
  if (score >= 60) return "text-amber-600";
  return "text-red-600";
}

function barColor(score) {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-amber-500";
  return "bg-red-500";
}

export default function HealthScoreCard({ overall, breakdown }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={HeartPulse}
        iconClassName="bg-emerald-50 text-emerald-600"
        title="Organization health"
        description="Composite score across security, activity, and follow-ups."
        preview
      />

      <div className="mt-4 flex items-center gap-5">
        <div className="flex size-20 shrink-0 items-center justify-center rounded-full border-4 border-zinc-100">
          <span className={`text-2xl font-bold ${scoreColor(overall)}`}>{overall}</span>
        </div>
        <div className="flex-1 space-y-2.5">
          {breakdown.map((item) => (
            <div key={item.label}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{item.label}</span>
                <span className="font-medium text-zinc-900">{item.score}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className={`h-full rounded-full ${barColor(item.score)}`} style={{ width: `${item.score}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}
