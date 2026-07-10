import { Flag } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

export default function FeatureFlagsCard({ flags }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Flag}
        iconClassName="bg-amber-50 text-amber-600"
        title="Feature flags"
        description="Global rollout status. Manage per-org in the organizations table."
        preview
      />

      <div className="mt-4 space-y-3">
        {flags.map((flag) => (
          <div key={flag.key}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-900">{flag.key}</span>
              <span className="text-xs text-zinc-500">{flag.rollout}% rollout</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-amber-500" style={{ width: `${flag.rollout}%` }} />
            </div>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
