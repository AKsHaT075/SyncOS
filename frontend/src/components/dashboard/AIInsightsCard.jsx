import { Sparkles, AlertTriangle, Info, AlertOctagon } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

const TONE_ICON = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertOctagon,
};

const TONE_STYLE = {
  info: "bg-sky-50 text-sky-600",
  warning: "bg-amber-50 text-amber-600",
  critical: "bg-red-50 text-red-600",
};

export default function AIInsightsCard({ insights, title = "AI Insights", grid = false }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Sparkles}
        iconClassName="bg-gradient-to-br from-violet-500 to-indigo-600 text-white"
        title={title}
        description="Generated from your workspace signals."
        preview
      />

      <div className={`mt-3 ${grid ? "grid gap-2 sm:grid-cols-2" : "space-y-2"}`}>
        {insights.map((insight, index) => {
          const tone = insight.tone ?? "info";
          const Icon = TONE_ICON[tone];
          return (
            <div key={index} className="flex items-start gap-2.5 rounded-xl border border-zinc-100 p-2.5">
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-lg ${TONE_STYLE[tone]}`}>
                <Icon className="size-3.5" />
              </span>
              <p className="text-xs leading-snug text-zinc-700">{insight.text}</p>
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}
