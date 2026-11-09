"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bucketLabel, labelOf, number } from "@/features/analytics/utils/format";

// Palette that reads in both themes and is not colour-only (series are also named in the legend / tooltip).
export const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#8b5cf6", "#ec4899", "#71717a"];
const STATUS_COLORS = {
  Todo: "#a1a1aa", "In Progress": "#3b82f6", "In Review": "#8b5cf6", Completed: "#10b981", Cancelled: "#71717a",
  Planning: "#a1a1aa", Active: "#3b82f6", "On Hold": "#f59e0b",
  Scheduled: "#3b82f6", Ended: "#10b981",
};
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--foreground)" };
const tick = { fontSize: 11, fill: "var(--muted-foreground)" };

export function NoData({ message = "No data for this period." }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>;
}

const hasValues = (series, keys) => series?.some((point) => keys.some((key) => point[key] > 0));

/** One or more series over time (days or months). `series` is [{date, key1, key2…}]. */
export function TrendChart({ series, lines, area = false, label }) {
  if (!hasValues(series, lines.map((line) => line.key))) return <NoData />;
  const Chart = area ? AreaChart : LineChart;
  return (
    <div className="h-60" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={series} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="date" tickFormatter={bucketLabel} tick={tick} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={bucketLabel} />
          {lines.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {lines.map((line, index) => (area
            ? <Area key={line.key} type="monotone" dataKey={line.key} name={line.label} stroke={line.color || COLORS[index]} fill={line.color || COLORS[index]} fillOpacity={0.15} strokeWidth={2} />
            : <Line key={line.key} type="monotone" dataKey={line.key} name={line.label} stroke={line.color || COLORS[index]} strokeWidth={2} dot={false} />))}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/** Distribution as a donut with a labelled list (counts are always visible, not just in a tooltip). */
export function Donut({ data, label }) {
  const rows = (data || []).filter((row) => row.count > 0).map((row, index) => ({ ...row, name: labelOf(row.key), color: STATUS_COLORS[row.key] || COLORS[index % COLORS.length] }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return <NoData message="Nothing to show yet." />;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-40 w-40 shrink-0" role="img" aria-label={`${label}: ${rows.map((row) => `${row.name} ${row.count}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="count" nameKey="name" innerRadius={46} outerRadius={72} paddingAngle={2} stroke="none">
              {rows.map((row) => <Cell key={row.key} fill={row.color} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-foreground">{number(total)}</span>
        </div>
      </div>
      <ul className="grid w-full flex-1 gap-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-full" style={{ background: row.color }} />{row.name}</span>
            <span className="font-medium text-foreground">{number(row.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars. `bars` = [{key,label,color?}] drawn grouped per row (name). */
export function Bars({ data, bars, label, height }) {
  const rows = (data || []).slice(0, 10);
  if (!rows.length || !rows.some((row) => bars.some((bar) => row[bar.key] > 0))) return <NoData message="Nothing to show yet." />;
  return (
    <div style={{ height: height || Math.max(180, rows.length * (bars.length > 1 ? 44 : 34)) }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="name" width={120} tick={tick} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} contentStyle={tooltipStyle} />
          {bars.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          {bars.map((bar, index) => <Bar key={bar.key} dataKey={bar.key} name={bar.label} fill={bar.color || COLORS[index]} radius={[0, 4, 4, 0]} barSize={bars.length > 1 ? 12 : 16} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
