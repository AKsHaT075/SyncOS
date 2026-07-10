import { ClipboardCheck } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

export default function OnboardingStatusCard({ hires }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={ClipboardCheck}
        iconClassName="bg-emerald-50 text-emerald-600"
        title="Onboarding status"
        description="New hires in progress."
        preview
      />

      <div className="mt-4 space-y-3">
        {hires.map((hire) => (
          <div key={hire.id}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-900">{hire.name}</span>
              <span className="text-xs text-zinc-500">{hire.progress}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${hire.progress}%` }} />
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">{hire.nextStep}</p>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
