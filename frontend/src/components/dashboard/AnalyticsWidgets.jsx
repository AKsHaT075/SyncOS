"use client";

import Link from "next/link";
import { ArrowRight, BarChart3, CalendarClock, FolderKanban, ListChecks, Users2 } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import { Bars, TrendChart } from "@/features/analytics/components/charts";
import { useAnalytics } from "@/features/analytics/hooks/analyticsHooks";
import { presetRange } from "@/features/analytics/utils/format";
import { formatDay } from "@/features/assets/utils/format";

const RANGE_30 = presetRange("30");

/** Real analytics for the dashboards. Same endpoints, scope rules and numbers as the Analytics page. */
export const useDashboardAnalytics = (type, { enabled = true } = {}) => useAnalytics(type, RANGE_30, { enabled });

const show = (query, value) => (query.isLoading ? "…" : value ?? "—");

/** KPI items for the dashboard strips; `…` while loading, `—` when a value can't be computed. */
export const kpi = (query, value) => show(query, value);

function Empty({ text }) {
  return <p className="mt-4 rounded-lg bg-zinc-50 px-3 py-6 text-center text-sm text-zinc-500">{text}</p>;
}

export function AnalyticsLink({ href = "/dashboard/analytics", children = "Open analytics" }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-700">
      {children}<ArrowRight className="size-3.5" />
    </Link>
  );
}

export function TaskTrendCard({ series, loading, title = "Tasks created vs completed", description = "Last 30 days." }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={ListChecks} iconClassName="bg-emerald-50 text-emerald-600" title={title} description={description} action={<AnalyticsLink />} />
      <div className="mt-3">
        {loading ? <Empty text="Loading…" /> : <TrendChart series={series} lines={[{ key: "created", label: "Created", color: "#6366f1" }, { key: "completed", label: "Completed", color: "#10b981" }]} label={title} />}
      </div>
    </DashboardCard>
  );
}

export function ProjectProgressCard({ data, loading }) {
  const rows = data?.breakdowns?.progressByProject ?? [];
  return (
    <DashboardCard>
      <DashboardCardHeader icon={FolderKanban} iconClassName="bg-violet-50 text-violet-600" title="Project progress" description="Share of each project's tasks that are completed." action={<AnalyticsLink href="/dashboard/analytics?view=projects" />} />
      <div className="mt-3">
        {loading ? <Empty text="Loading…" /> : rows.length ? <Bars data={rows} bars={[{ key: "progress", label: "Progress %", color: "#6366f1" }]} label="Project progress" /> : <Empty text="No projects with tasks yet." />}
      </div>
    </DashboardCard>
  );
}

export function WorkloadCard({ rows, loading, title = "Workload", description = "Open tasks per person. Counts only, not performance." }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={Users2} iconClassName="bg-amber-50 text-amber-600" title={title} description={description} action={<AnalyticsLink href="/dashboard/analytics?view=people" />} />
      <div className="mt-3">
        {loading ? <Empty text="Loading…" /> : <Bars data={(rows ?? []).map((row) => ({ ...row, name: row.name }))} bars={[{ key: "open", label: "Open", color: "#3b82f6" }, { key: "overdue", label: "Overdue", color: "#ef4444" }]} label={title} />}
      </div>
    </DashboardCard>
  );
}

export function TeamSizeCard({ rows, loading }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={Users2} iconClassName="bg-indigo-50 text-indigo-600" title="Team distribution" description="Members per team." action={<AnalyticsLink href="/dashboard/analytics?view=people" />} />
      <div className="mt-3">
        {loading ? <Empty text="Loading…" /> : <Bars data={rows ?? []} bars={[{ key: "count", label: "Members" }]} label="Members per team" />}
      </div>
    </DashboardCard>
  );
}

function ListRows({ items, render, empty }) {
  return items.length ? <ul className="mt-3 divide-y divide-zinc-100 text-sm">{items.map(render)}</ul> : <Empty text={empty} />;
}

export function DeadlinesCard({ upcoming = [], overdue = [], loading }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={ListChecks} iconClassName="bg-violet-50 text-violet-600" title="Deadlines" description="Overdue first, then the next 14 days." action={<AnalyticsLink href="/dashboard/analytics?view=me" />} />
      {loading ? <Empty text="Loading…" /> : (
        <ListRows
          items={[...overdue.map((task) => ({ ...task, late: true })), ...upcoming]}
          empty="Nothing due. You're all caught up."
          render={(task) => (
            <li key={`${task.id}-${task.late ? "o" : "u"}`} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate"><span className="font-medium text-zinc-900">{task.title}</span>{task.project ? <span className="ml-2 text-xs text-zinc-500">{task.project}</span> : null}</span>
              <span className={`shrink-0 text-xs ${task.late ? "font-medium text-red-600" : "text-zinc-500"}`}>{task.late ? "Overdue · " : ""}{formatDay(task.dueDate)}</span>
            </li>
          )}
        />
      )}
    </DashboardCard>
  );
}

export function MyProjectsRealCard({ projects = [], loading }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={FolderKanban} iconClassName="bg-emerald-50 text-emerald-600" title="My projects" description="Projects you own or belong to." action={<AnalyticsLink href="/dashboard/projects">All projects</AnalyticsLink>} />
      {loading ? <Empty text="Loading…" /> : (
        <ListRows items={projects} empty="You aren't on any projects yet." render={(project) => (
          <li key={project.id} className="flex items-center justify-between gap-3 py-2">
            <Link href={`/dashboard/projects/${project.id}`} className="truncate font-medium text-zinc-900 hover:underline">{project.name}</Link>
            <span className="shrink-0 text-xs text-zinc-500">{project.role} · {project.status}</span>
          </li>
        )} />
      )}
    </DashboardCard>
  );
}

export function MyMeetingsRealCard({ meetings = [], loading }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={CalendarClock} iconClassName="bg-sky-50 text-sky-600" title="Upcoming meetings" description="Your next scheduled meetings." action={<AnalyticsLink href="/dashboard/meetings">All meetings</AnalyticsLink>} />
      {loading ? <Empty text="Loading…" /> : (
        <ListRows items={meetings} empty="No upcoming meetings." render={(meeting) => (
          <li key={meeting.id} className="flex items-center justify-between gap-3 py-2">
            <span className="truncate font-medium text-zinc-900">{meeting.topic}</span>
            <span className="shrink-0 text-xs text-zinc-500">{new Date(meeting.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
          </li>
        )} />
      )}
    </DashboardCard>
  );
}

export function RestrictedAnalyticsCard() {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={BarChart3} iconClassName="bg-zinc-100 text-zinc-500" title="Analytics" description="Guest accounts are read-only and don't have analytics." />
    </DashboardCard>
  );
}

export function PlatformGrowthCard({ series, loading }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={BarChart3} iconClassName="bg-emerald-50 text-emerald-600" title="Growth" description="New organizations and users, last 30 days." action={<AnalyticsLink />} />
      <div className="mt-3">
        {loading ? <Empty text="Loading…" /> : <TrendChart series={series} lines={[{ key: "organizations", label: "New organizations", color: "#6366f1" }, { key: "users", label: "New users", color: "#10b981" }]} label="Platform growth" />}
      </div>
    </DashboardCard>
  );
}
