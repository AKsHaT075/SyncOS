"use client";

import { Database } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import { useOrganizationUsage } from "@/features/account/hooks/accountHooks";

function barColor(pct) {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-sky-500";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// Real plan usage (seats and storage against the organization's limits). Shown to organization admins only, like the API behind it.
export default function ResourceUsageCard() {
  const { data, isLoading, isError } = useOrganizationUsage();
  const rows = data
    ? [
        { label: "Seats", used: data.seats.used + data.seats.pendingInvitations, total: data.seats.limit, text: `${data.seats.used + data.seats.pendingInvitations}${data.seats.limit ? ` / ${data.seats.limit}` : ""}` },
        { label: "Storage", used: data.storage.usedBytes, total: data.storage.limitBytes, text: `${formatBytes(data.storage.usedBytes)}${data.storage.limitBytes ? ` / ${formatBytes(data.storage.limitBytes)}` : ""}` },
      ]
    : [];

  return (
    <DashboardCard>
      <DashboardCardHeader icon={Database} iconClassName="bg-sky-50 text-sky-600" title="Plan usage" description="Seats include pending invitations." />
      <div className="mt-3 space-y-3">
        {isLoading ? <p className="text-xs text-zinc-500">Loading…</p> : null}
        {isError ? <p className="text-xs text-zinc-500">Usage could not be loaded.</p> : null}
        {rows.map((row) => {
          const pct = row.total ? Math.min(100, Math.round((row.used / row.total) * 100)) : 0;
          return (
            <div key={row.label}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{row.label}</span>
                <span className="font-medium text-zinc-900">{row.text}</span>
              </div>
              {row.total ? (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                  <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}
