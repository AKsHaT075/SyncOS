"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Users } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import { TEAM_INSIGHTS } from "@/components/dashboard/mockDashboardData";

// People module has no "list members" endpoint yet — role mix is a preview,
// headcount/seatsLimit below comes from the real organization record.
const ROLE_MIX = [
  { name: "Org admin", value: 1, color: "#6366f1" },
  { name: "Manager", value: 2, color: "#0ea5e9" },
  { name: "Employee", value: 6, color: "#10b981" },
  { name: "Guest", value: 1, color: "#a1a1aa" },
];

export default function TeamSnapshotCard({ seatsLimit }) {
  const headcount = ROLE_MIX.reduce((sum, item) => sum + item.value, 0);
  const hasLimit = Number.isFinite(seatsLimit) && seatsLimit > 0;

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Users}
        iconClassName="bg-indigo-50 text-indigo-600"
        title="Team"
        description={hasLimit ? `${headcount} / ${seatsLimit} seats` : `${headcount} members`}
        preview
      />

      <div className="mt-3 flex items-center gap-3">
        <div className="h-20 w-20 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={ROLE_MIX} dataKey="value" nameKey="name" innerRadius={24} outerRadius={36} paddingAngle={3}>
                {ROLE_MIX.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} stroke="none" />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e4e4e7", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          {ROLE_MIX.map((item) => (
            <span key={item.name} className="flex items-center gap-1.5 text-xs text-zinc-600">
              <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.name} · {item.value}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2.5 text-xs">
        <span className="text-zinc-500">
          Most active <span className="font-medium text-zinc-900">{TEAM_INSIGHTS.mostActive}</span>
        </span>
        <span className="text-zinc-500">
          Largest <span className="font-medium text-zinc-900">{TEAM_INSIGHTS.largest} ({TEAM_INSIGHTS.largestCount})</span>
        </span>
      </div>
    </DashboardCard>
  );
}
