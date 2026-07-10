import { AlertTriangle } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

const RISK_STYLES = {
  "at risk": "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
};

export default function AtRiskProjectsCard({ projects }) {
  const atRisk = projects.filter((project) => project.status === "at risk" || project.status === "blocked");

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={AlertTriangle}
        iconClassName="bg-red-50 text-red-600"
        title="At-risk projects"
        description="Needs attention this week."
        preview
      />

      <div className="mt-4 space-y-2">
        {atRisk.length === 0 ? (
          <EmptyStateCard icon={AlertTriangle} title="Nothing at risk" description="All projects are on track." />
        ) : (
          atRisk.map((project) => (
            <div key={project.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">{project.name}</p>
                <p className="text-xs text-zinc-500">Due {project.due}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${RISK_STYLES[project.status]}`}>
                  {project.status}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
