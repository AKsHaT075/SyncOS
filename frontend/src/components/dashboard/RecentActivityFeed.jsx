import { Activity } from "lucide-react";
import { CheckCircle2, XCircle } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

function formatRelativeTime(dateInput) {
  const date = new Date(dateInput);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function humanizeAction(action) {
  if (!action) return "Unknown action";
  return action.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// `preview` mode renders hand-written, already-readable strings (no audit-log
// permission required) — used on roles that can't call the org-admin-only
// /audit-logs endpoint yet.
export default function RecentActivityFeed({ logs, isLoading, limit = 6, preview = false }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Activity}
        iconClassName="bg-sky-50 text-sky-600"
        title="Recent activity"
        description="Latest actions across your workspace."
      />

      <div className="mt-5 space-y-1">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : !logs || logs.length === 0 ? (
          <EmptyStateCard
            icon={Activity}
            title="No activity yet"
            description="Actions taken in your workspace will show up here."
          />
        ) : (
          logs.slice(0, limit).map((log) => (
            <div key={log._id ?? log.id} className="flex items-start gap-3 rounded-lg px-2 py-2.5">
              <span
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                  log.success === false ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"
                }`}
              >
                {log.success === false ? <XCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-700">
                  <span className="font-medium text-zinc-900">
                    {preview ? log.text : humanizeAction(log.action)}
                  </span>
                  {!preview && log.user?.email ? ` · ${log.user.email}` : ""}
                </p>
                <p className="text-xs text-zinc-500">{preview ? log.time : formatRelativeTime(log.createdAt)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
