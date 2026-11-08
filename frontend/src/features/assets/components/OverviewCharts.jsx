"use client";

import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STATUS_BY_VALUE } from "@/features/assets/constants/assetOptions";

const tooltipStyle = {
  background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--foreground)",
};

export function StatusDonut({ data }) {
  const rows = data.filter((row) => row.count > 0).map((row) => ({ ...row, label: STATUS_BY_VALUE[row.status]?.label ?? row.status, color: STATUS_BY_VALUE[row.status]?.dot ?? "#71717a" }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return <p className="py-10 text-center text-sm text-muted-foreground">No assets yet.</p>;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-44 w-44 shrink-0" role="img" aria-label={`Assets by status: ${rows.map((r) => `${r.label} ${r.count}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="count" nameKey="label" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">
              {rows.map((row) => <Cell key={row.status} fill={row.color} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-foreground">{total}</span>
          <span className="text-[11px] text-muted-foreground">assets</span>
        </div>
      </div>
      <ul className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.status} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-full" style={{ background: row.color }} />{row.label}</span>
            <span className="font-medium text-foreground">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HorizontalBars({ data, label }) {
  if (!data.length) return <p className="py-10 text-center text-sm text-muted-foreground">Nothing to show yet.</p>;
  const rows = data.slice(0, 8);
  return (
    <div style={{ height: Math.max(160, rows.length * 34) }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} contentStyle={tooltipStyle} />
          <Bar dataKey="count" name="Assets" fill="var(--primary)" radius={[0, 4, 4, 0]} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
