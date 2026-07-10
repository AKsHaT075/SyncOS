"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { TrendingUp, CheckCircle2, XCircle } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

function formatRelativeTime(dateInput) {
  const date = new Date(dateInput);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  return date.toLocaleDateString();
}

function humanizeAction(action) {
  return action.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function ActivityOverviewCard({ trend, logs, isLoading, eventCount }) {
  return (
    <DashboardCard>
      <div className="flex items-center justify-between">
        <DashboardCardHeader
          icon={TrendingUp}
          iconClassName="bg-sky-50 text-sky-600"
          title="Activity"
          description="Trend and latest events across your workspace."
        />
        <span className="text-xs font-medium text-zinc-400">{isLoading ? "…" : `${eventCount} events`}</span>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#f1f1f4" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#a1a1aa" }} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#a1a1aa" }} width={20} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e4e4e7", fontSize: 12 }} labelStyle={{ fontWeight: 600 }} />
              <Area type="monotone" dataKey="count" name="Events" stroke="#6366f1" strokeWidth={2} fill="url(#activityFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="space-y-1.5 border-l border-zinc-100 pl-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Recent logs</p>
          <div className="h-24 space-y-1 overflow-y-auto">
            {isLoading ? (
              <p className="py-6 text-center text-xs text-zinc-400">Loading…</p>
            ) : !logs || logs.length === 0 ? (
              <EmptyStateCard icon={TrendingUp} title="No recent events" />
            ) : (
              logs.slice(0, 4).map((log) => (
                <div key={log._id ?? log.id} className="flex items-center gap-2">
                  {log.success ? (
                    <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="size-3 shrink-0 text-red-500" />
                  )}
                  <span className="truncate text-xs text-zinc-700">{humanizeAction(log.action)}</span>
                  <span className="ml-auto shrink-0 text-[0.65rem] text-zinc-400">{formatRelativeTime(log.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardCard>
  );
}
