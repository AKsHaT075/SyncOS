import { FolderKanban } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

const STATUS_STYLES = {
  "on track": "bg-emerald-50 text-emerald-700",
  "at risk": "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  done: "bg-zinc-100 text-zinc-600",
};

export default function MyProjectsCard({ projects }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={FolderKanban}
        iconClassName="bg-emerald-50 text-emerald-600"
        title="My projects"
        description="Projects you're contributing to."
        preview
      />

      <div className="mt-3 space-y-1.5">
        {projects.map((project) => (
          <div key={project.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900">{project.name}</p>
              <p className="text-xs text-zinc-500">
                {project.role} · updated {project.lastUpdated}
              </p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLES[project.status]}`}>
              {project.status}
            </span>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
