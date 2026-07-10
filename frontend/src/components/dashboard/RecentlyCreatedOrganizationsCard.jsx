import { Sparkles } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function RecentlyCreatedOrganizationsCard({ organizations, isLoading }) {
  const recent = (organizations ?? []).slice(0, 6);

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Sparkles}
        iconClassName="bg-emerald-50 text-emerald-600"
        title="Recently created"
        description="Newest tenants on the platform."
      />

      <div className="mt-4 space-y-1">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : recent.length === 0 ? (
          <EmptyStateCard icon={Sparkles} title="No organizations yet" />
        ) : (
          recent.map((org) => (
            <div key={org.id} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-zinc-50">
              <span className="truncate text-sm font-medium text-zinc-900">{org.name}</span>
              <span className="shrink-0 text-xs text-zinc-500">{new Date(org.createdAt).toLocaleDateString()}</span>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
