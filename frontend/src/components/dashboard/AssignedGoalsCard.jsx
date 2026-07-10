import { Target } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

export default function AssignedGoalsCard({ goals }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Target}
        iconClassName="bg-sky-50 text-sky-600"
        title="Assigned goals"
        description="Tracked for this quarter."
        preview
      />

      <div className="mt-4 space-y-3">
        {goals.map((goal) => (
          <div key={goal.id}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-900">{goal.title}</span>
              <span className="text-xs text-zinc-500">{goal.progress}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-sky-500" style={{ width: `${goal.progress}%` }} />
            </div>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
