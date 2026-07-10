import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Gauge } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

function barColor(value) {
  if (value >= 90) return "#ef4444";
  if (value >= 75) return "#f59e0b";
  return "#10b981";
}

export default function TeamWorkloadCard({ workload }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Gauge}
        iconClassName="bg-amber-50 text-amber-600"
        title="Team workload"
        description="Capacity utilization by team."
        preview
      />

      <div className="mt-4 h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={workload} layout="vertical" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid horizontal={false} stroke="#f1f1f4" />
            <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: "#a1a1aa" }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="team" width={90} tick={{ fontSize: 12, fill: "#52525b" }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: "1px solid #e4e4e7", fontSize: 12 }}
              formatter={(value) => [`${value}%`, "Utilization"]}
            />
            <Bar dataKey="utilization" radius={[0, 8, 8, 0]} maxBarSize={20}>
              {workload.map((entry) => (
                <Cell key={entry.team} fill={barColor(entry.utilization)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </DashboardCard>
  );
}
