"use client";

import Link from "next/link";
import { AlertTriangle, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bars, Donut, TrendChart } from "@/features/analytics/components/charts";
import { KpiGrid, Notes, Panel, QueryBoundary } from "@/features/analytics/components/ui";
import { useAnalytics, usePlatformAnalytics } from "@/features/analytics/hooks/analyticsHooks";
import { formatDay } from "@/features/assets/utils/format";
import { formatMoney } from "@/features/assets/utils/format";

const STATUS_BARS = [{ key: "open", label: "Open", color: "#3b82f6" }, { key: "completed", label: "Completed", color: "#10b981" }, { key: "overdue", label: "Overdue", color: "#ef4444" }];
const TASK_TREND = [{ key: "created", label: "Created", color: "#6366f1" }, { key: "completed", label: "Completed", color: "#10b981" }];

/** The five numbers every task view starts with, from the server's `kpis`. */
const taskKpis = (k) => [
  { label: "Open tasks", value: k.open }, { label: "Completed", value: k.completed, hint: k.completionRate === null ? undefined : `${k.completionRate}% of tasks` },
  { label: "Overdue", value: k.overdue, tone: k.overdue > 0 ? "text-destructive" : undefined }, { label: "Avg. time to complete", value: k.avgCompletionDays, suffix: k.avgCompletionDays === null ? "" : " days", hint: k.avgCompletionSample ? `from ${k.avgCompletionSample} completed task${k.avgCompletionSample === 1 ? "" : "s"}` : "no completed tasks yet" },
];

export function TasksSection({ data }) {
  return (
    <>
      <KpiGrid items={[...taskKpis(data.kpis), { label: "Created in period", value: data.kpis.createdInRange }, { label: "Completed in period", value: data.kpis.completedInRange }, { label: "Total tasks", value: data.kpis.total }, { label: "Cancelled", value: data.kpis.cancelled }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Created vs completed"><TrendChart series={data.series.createdVsCompleted} lines={TASK_TREND} label="Tasks created and completed over time" /></Panel>
        <Panel title="Status"><Donut data={data.breakdowns.byStatus} label="Tasks by status" /></Panel>
        <Panel title="Priority" description="Open, completed and overdue tasks by priority">
          <Bars data={data.breakdowns.byPriority.map((row) => ({ ...row, name: row.key }))} bars={STATUS_BARS} label="Tasks by priority" />
        </Panel>
        <Panel title="Open tasks past their due date" description="By the day they were due">
          <TrendChart series={data.series.overdueByDueDate} lines={[{ key: "overdue", label: "Overdue", color: "#ef4444" }]} area label="Overdue tasks by due date" />
        </Panel>
        {data.breakdowns.byProject ? <Panel title="By project"><Bars data={data.breakdowns.byProject} bars={STATUS_BARS} label="Tasks by project" /></Panel> : null}
        <Panel title="By assignee" description="People with the most assigned tasks"><Bars data={data.breakdowns.byAssignee} bars={STATUS_BARS} label="Tasks by assignee" /></Panel>
      </div>
    </>
  );
}

export function ProjectsSection({ data }) {
  const k = data.kpis;
  return (
    <>
      <KpiGrid items={[{ label: "Projects", value: k.total }, { label: "Active", value: k.active }, { label: "Completed", value: k.completed, hint: k.completionRate === null ? undefined : `${k.completionRate}% completion` }, { label: "Overdue", value: k.overdue, tone: k.overdue > 0 ? "text-destructive" : undefined },
        { label: "On hold", value: k.onHold }, { label: "Planning", value: k.planning }, { label: "Completed in period", value: k.completedInRange }, { label: "Avg. planned duration", value: k.avgPlannedDurationDays, suffix: k.avgPlannedDurationDays === null ? "" : " days" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Status"><Donut data={data.breakdowns.byStatus} label="Projects by status" /></Panel>
        <Panel title="Priority"><Donut data={data.breakdowns.byPriority} label="Projects by priority" /></Panel>
        <Panel title="Projects completed over time"><TrendChart series={data.series.completedOverTime} lines={[{ key: "completed", label: "Completed", color: "#10b981" }]} area label="Projects completed over time" /></Panel>
        {data.breakdowns.progressByProject ? (
          <Panel title="Progress by project" description="Share of tasks completed">
            <Bars data={data.breakdowns.progressByProject} bars={[{ key: "progress", label: "Progress %", color: "#6366f1" }]} label="Project progress" />
          </Panel>
        ) : <Panel title="Project detail"><p className="py-6 text-sm text-muted-foreground">Per-project figures aren&apos;t shown for your role. Only totals are available.</p></Panel>}
      </div>
    </>
  );
}

export function PeopleSection({ data }) {
  const k = data.kpis;
  return (
    <>
      <KpiGrid items={[{ label: "Active members", value: k.members }, { label: "Blocked", value: k.blocked }, { label: "New in period", value: k.newInRange }, { label: "Avg. open tasks per person", value: k.avgOpenPerPerson },
        { label: "People with open work", value: k.withOpenTasks }, { label: "Open tasks", value: k.totalOpen }, { label: "Overdue tasks", value: k.totalOverdue, tone: k.totalOverdue > 0 ? "text-destructive" : undefined }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Workload" description="People with the most open tasks. Counts only, not performance."><Bars data={data.breakdowns.workload} bars={[{ key: "open", label: "Open", color: "#3b82f6" }, { key: "overdue", label: "Overdue", color: "#ef4444" }, { key: "completed", label: "Completed in period", color: "#10b981" }]} label="Workload per person" /></Panel>
        <Panel title="Team size"><Bars data={data.breakdowns.byTeam} bars={[{ key: "count", label: "Members" }]} label="Members per team" /></Panel>
        <Panel title="Roles"><Donut data={data.breakdowns.byRole} label="Members by role" /></Panel>
      </div>
    </>
  );
}

export function TeamsSection({ data }) {
  const k = data.kpis;
  return (
    <>
      <KpiGrid items={[{ label: "Teams", value: k.teams }, { label: "Avg. team size", value: k.avgTeamSize }, { label: "Largest team", value: k.largestTeam }, { label: "Open tasks", value: k.totalOpen }, { label: "Overdue tasks", value: k.totalOverdue, tone: k.totalOverdue > 0 ? "text-destructive" : undefined }]} />
      <Panel title="Team comparison" description="Open, completed (in period) and overdue task assignments per team">
        <Bars data={data.breakdowns.byTeam} bars={[{ key: "open", label: "Open", color: "#3b82f6" }, { key: "completed", label: "Completed", color: "#10b981" }, { key: "overdue", label: "Overdue", color: "#ef4444" }]} label="Tasks per team" />
      </Panel>
    </>
  );
}

export function MeetingsSection({ data }) {
  const k = data.kpis;
  return (
    <>
      <KpiGrid items={[{ label: "Meetings", value: k.total }, { label: "Held", value: k.ended }, { label: "Cancelled", value: k.cancelled }, { label: "Attendance", value: k.attendanceRate, suffix: k.attendanceRate === null ? "" : "%", hint: `${k.attended} of ${k.invitations} invitations joined` },
        { label: "Accepted", value: k.accepted }, { label: "Declined", value: k.declined }, { label: "Planned length", value: k.avgPlannedMinutes, suffix: k.avgPlannedMinutes === null ? "" : " min" }, { label: "Actual length", value: k.avgActualMinutes, suffix: k.avgActualMinutes === null ? "" : " min", hint: k.avgActualSample ? `from ${k.avgActualSample} meeting${k.avgActualSample === 1 ? "" : "s"}` : "not enough records" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Meetings over time"><TrendChart series={data.series.meetingsOverTime} lines={[{ key: "meetings", label: "Meetings", color: "#6366f1" }]} area label="Meetings over time" /></Panel>
        <Panel title="Status"><Donut data={data.breakdowns.byStatus} label="Meetings by status" /></Panel>
        <Panel title="Type"><Donut data={data.breakdowns.byType} label="Meetings by type" /></Panel>
      </div>
    </>
  );
}

export function AssetsSection({ data }) {
  const k = data.kpis;
  const spend = data.breakdowns.maintenanceSpend;
  return (
    <>
      <KpiGrid items={[{ label: "Assets", value: k.total }, { label: "Assigned", value: k.assigned }, { label: "Available", value: k.available }, { label: "Under maintenance", value: k.underMaintenance },
        { label: "Utilization", value: k.utilization, suffix: k.utilization === null ? "" : "%" }, { label: "Expired warranties", value: k.expiredWarranties, tone: k.expiredWarranties > 0 ? "text-destructive" : undefined }, { label: "License seats used", value: k.seatsAllocated, hint: `of ${k.seatsPurchased}` }, { label: "Open repair requests", value: k.openMaintenanceRequests }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By status"><Donut data={data.breakdowns.byStatus} label="Assets by status" /></Panel>
        <Panel title="By category"><Bars data={data.breakdowns.byCategory} bars={[{ key: "count", label: "Assets" }]} label="Assets by category" /></Panel>
        <Panel title="By team"><Bars data={data.breakdowns.byTeam} bars={[{ key: "count", label: "Assets" }]} label="Assets by team" /></Panel>
        <Panel title="Assignments over time"><TrendChart series={data.series.assignments} lines={[{ key: "assigned", label: "Assigned", color: "#6366f1" }]} area label="Assignments over time" /></Panel>
        {data.breakdowns.purchaseValue ? (
          <Panel title="Purchase value" description="One total per currency; currencies are never added together.">
            <ul className="grid gap-2 sm:grid-cols-2">{data.breakdowns.purchaseValue.map((row) => <li key={row.currency} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{row.currency} · {row.assets} assets</p><p className="text-lg font-semibold text-foreground">{formatMoney(row.total, row.currency)}</p></li>)}</ul>
          </Panel>
        ) : null}
        {spend ? (
          <Panel title="Maintenance spend" description="Completed jobs in the selected period">
            {spend.length ? <ul className="grid gap-2 sm:grid-cols-2">{spend.map((row) => <li key={row.currency} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{row.currency} · {row.jobs} jobs</p><p className="text-lg font-semibold text-foreground">{formatMoney(row.total, row.currency)}</p></li>)}</ul> : <p className="py-4 text-sm text-muted-foreground">No maintenance costs recorded in this period.</p>}
          </Panel>
        ) : null}
        <Panel title="Warranties expiring soon">
          {data.breakdowns.expiringWarranties.length ? <ul className="divide-y divide-border text-sm">{data.breakdowns.expiringWarranties.map((a) => <li key={a.id} className="flex justify-between py-2"><Link href={`/dashboard/assets/${a.id}`} className="font-medium text-foreground hover:underline">{a.name}</Link><span className="text-muted-foreground">{formatDay(a.expiryDate)} · {a.daysLeft}d</span></li>)}</ul> : <p className="py-4 text-sm text-muted-foreground">None in the next 30 days.</p>}
        </Panel>
        <Panel title="Licenses expiring soon">
          {data.breakdowns.expiringLicenses.length ? <ul className="divide-y divide-border text-sm">{data.breakdowns.expiringLicenses.map((a) => <li key={a.id} className="flex justify-between py-2"><Link href={`/dashboard/assets/${a.id}`} className="font-medium text-foreground hover:underline">{a.name}</Link><span className="text-muted-foreground">{formatDay(a.expiryDate || a.renewalDate)}</span></li>)}</ul> : <p className="py-4 text-sm text-muted-foreground">None in the next 30 days.</p>}
        </Panel>
      </div>
    </>
  );
}

export function PersonalSection({ data }) {
  const k = data.kpis;
  const L = data.lists;
  const rows = (items, render, empty) => (items.length ? <ul className="divide-y divide-border text-sm">{items.map(render)}</ul> : <p className="py-4 text-sm text-muted-foreground">{empty}</p>);
  return (
    <>
      <KpiGrid items={[{ label: "Open tasks", value: k.open }, { label: "Completed", value: k.completed, hint: `${k.completedInRange} in this period` }, { label: "Overdue", value: k.overdue, tone: k.overdue > 0 ? "text-destructive" : undefined }, { label: "Due in 14 days", value: k.dueSoon },
        { label: "Projects", value: k.projects }, { label: "Meetings", value: k.meetings, hint: k.meetingAttendanceRate === null ? undefined : `${k.meetingAttendanceRate}% joined` }, { label: "Assets", value: k.assets }, { label: "Open workload", value: k.estimatedHoursOpen, suffix: " h", hint: "estimated hours on open tasks" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="My tasks"><TrendChart series={data.series.createdVsCompleted} lines={TASK_TREND} label="My tasks created and completed" /></Panel>
        <Panel title="Status"><Donut data={data.breakdowns.byStatus} label="My tasks by status" /></Panel>
        <Panel title="Upcoming deadlines">{rows(L.upcomingDeadlines, (t) => <li key={t.id} className="flex justify-between gap-3 py-2"><span className="min-w-0 truncate"><span className="font-medium text-foreground">{t.title}</span><span className="ml-2 text-xs text-muted-foreground">{t.project}</span></span><span className="shrink-0 text-muted-foreground">{formatDay(t.dueDate)}</span></li>, "Nothing due in the next 14 days.")}</Panel>
        <Panel title="Overdue" action={k.overdue > 0 ? <AlertTriangle className="size-4 text-destructive" aria-hidden="true" /> : null}>{rows(L.overdueTasks, (t) => <li key={t.id} className="flex justify-between gap-3 py-2"><span className="truncate font-medium text-foreground">{t.title}</span><span className="shrink-0 text-destructive">due {formatDay(t.dueDate)}</span></li>, "You have no overdue tasks.")}</Panel>
        <Panel title="My projects">{rows(L.projects, (p) => <li key={p.id} className="flex justify-between py-2"><Link href={`/dashboard/projects/${p.id}`} className="font-medium text-foreground hover:underline">{p.name}</Link><span className="text-muted-foreground">{p.role}</span></li>, "You aren't on any projects yet.")}</Panel>
        <Panel title="Upcoming meetings">{rows(L.upcomingMeetings, (m) => <li key={m.id} className="flex justify-between py-2"><span className="font-medium text-foreground">{m.topic}</span><span className="text-muted-foreground">{new Date(m.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span></li>, "No upcoming meetings.")}</Panel>
        <Panel title="My assets">{rows(L.assets, (a) => <li key={a.id} className="flex justify-between py-2"><Link href={`/dashboard/assets/${a.id}`} className="font-medium text-foreground hover:underline">{a.name}</Link><span className="text-muted-foreground">{a.assetId}</span></li>, "No assets assigned to you.")}</Panel>
        <Panel title="My activity"><TrendChart series={data.series.activity} lines={[{ key: "actions", label: "Actions", color: "#6366f1" }]} area label="My activity over time" /></Panel>
      </div>
    </>
  );
}

const OVERVIEW_KPIS = (sections, mode) => {
  const t = sections.tasks.kpis; const p = sections.projects.kpis; const m = sections.meetings.kpis; const people = sections.people.kpis;
  return [
    { label: mode === "team" ? "Team members" : "Active members", value: people.members }, { label: "Projects", value: p.total, hint: `${p.active} active` },
    { label: "Open tasks", value: t.open }, { label: "Overdue tasks", value: t.overdue, tone: t.overdue > 0 ? "text-destructive" : undefined },
    { label: "Completed in period", value: t.completedInRange }, { label: "Completion rate", value: t.completionRate, suffix: t.completionRate === null ? "" : "%" },
    { label: "Meetings", value: m.total, hint: m.attendanceRate === null ? undefined : `${m.attendanceRate}% attendance` }, { label: "Overdue projects", value: p.overdue, tone: p.overdue > 0 ? "text-destructive" : undefined },
  ];
};

export function OverviewSection({ data }) {
  if (data.mode === "personal") return <PersonalSection data={data} />;
  const { sections } = data;
  return (
    <>
      <KpiGrid items={OVERVIEW_KPIS(sections, data.scope.kind)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Created vs completed"><TrendChart series={sections.tasks.series.createdVsCompleted} lines={TASK_TREND} label="Tasks created and completed" /></Panel>
        <Panel title="Task status"><Donut data={sections.tasks.breakdowns.byStatus} label="Tasks by status" /></Panel>
        <Panel title="Workload" description="Open tasks per person (counts only)"><Bars data={sections.people.breakdowns.workload} bars={[{ key: "open", label: "Open", color: "#3b82f6" }, { key: "overdue", label: "Overdue", color: "#ef4444" }]} label="Open tasks per person" /></Panel>
        <Panel title="Organization activity"><TrendChart series={data.series.activity} lines={[{ key: "actions", label: "Actions", color: "#6366f1" }]} area label="Activity over time" /></Panel>
        {sections.assets ? <Panel title="Assets"><Donut data={sections.assets.breakdowns.byStatus} label="Assets by status" /></Panel> : null}
        <Panel title="Projects"><Donut data={sections.projects.breakdowns.byStatus} label="Projects by status" /></Panel>
      </div>
    </>
  );
}

export function PlatformSection({ params }) {
  const query = usePlatformAnalytics(params);
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <>
          <KpiGrid items={[{ label: "Organizations", value: data.kpis.organizations, hint: `${data.kpis.activeOrganizations} active · ${data.kpis.suspendedOrganizations} suspended` }, { label: "New organizations", value: data.kpis.newOrganizations },
            { label: "Users", value: data.kpis.users, hint: `${data.kpis.activeUsers} active · ${data.kpis.blockedUsers} blocked` }, { label: "New users", value: data.kpis.newUsers },
            { label: "Sign-ins in period", value: data.kpis.logins }, { label: "Avg. users per organization", value: data.kpis.avgUsersPerOrganization }]} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Organization growth"><TrendChart series={data.series.organizationGrowth} lines={[{ key: "organizations", label: "New organizations", color: "#6366f1" }]} area label="New organizations over time" /></Panel>
            <Panel title="User growth"><TrendChart series={data.series.userGrowth} lines={[{ key: "users", label: "New users", color: "#10b981" }]} area label="New users over time" /></Panel>
            <Panel title="Sign-in activity"><TrendChart series={data.series.logins} lines={[{ key: "logins", label: "Sign-ins", color: "#6366f1" }, { key: "accounts", label: "Distinct accounts", color: "#f59e0b" }]} label="Sign-ins over time" /></Panel>
            <Panel title="Plans"><Donut data={data.breakdowns.plans} label="Organizations by plan" /></Panel>
          </div>
          <Notes notes={data.notes} />
        </>
      )}
    </QueryBoundary>
  );
}

const SECTIONS = { overview: OverviewSection, me: PersonalSection, tasks: TasksSection, projects: ProjectsSection, people: PeopleSection, teams: TeamsSection, meetings: MeetingsSection, assets: AssetsSection };

/** Fetches one analytics view and renders it with the server's notes about approximate data. */
export function AnalyticsView({ type, params }) {
  const query = useAnalytics(type, params);
  const Section = SECTIONS[type];
  return (
    <QueryBoundary query={query}>
      {(data) => (
        <>
          <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{data.range.from} → {data.range.to} · {data.range.timeZone}{data.scope?.kind === "aggregate" ? " · counts only" : ""}</span>
            <Button variant="ghost" size="sm" className="print:hidden" onClick={() => window.print()}><Printer className="size-4" />Print</Button>
          </p>
          <Section data={data} />
          <Notes notes={data.notes} />
        </>
      )}
    </QueryBoundary>
  );
}
