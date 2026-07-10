import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Users2 } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

export default function EmployeeDistributionCard({ departments }) {
  const total = departments.reduce((sum, item) => sum + item.value, 0);

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Users2}
        iconClassName="bg-indigo-50 text-indigo-600"
        title="Employee distribution"
        description="Headcount by department."
        preview
      />

      <div className="mt-3 flex items-center gap-4">
        <div className="h-32 w-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={departments} dataKey="value" nameKey="name" innerRadius={36} outerRadius={52} paddingAngle={3}>
                {departments.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} stroke="none" />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e4e4e7", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          {departments.map((item) => (
            <span key={item.name} className="flex items-center gap-1.5 text-xs text-zinc-600">
              <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.name} · {item.value} ({Math.round((item.value / total) * 100)}%)
            </span>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}
