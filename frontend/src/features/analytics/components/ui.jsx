"use client";

import { Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, Field, NativeSelect, Panel } from "@/features/assets/components/shared";
import { PRESETS, formatNumber } from "@/features/analytics/utils/ui";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { usePeople } from "@/features/people/hooks/usePeople";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { cn } from "@/lib/utils";

export { Panel };

export function KpiGrid({ items, loading }) {
  if (loading) return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{item.label}</p>
          <p className={cn("mt-1 text-2xl font-bold text-foreground", item.tone)}>{formatNumber(item.value, item.suffix)}</p>
          {item.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

/** "Approximate" / "incomplete history" explanations the server attaches to a view. Always shown, never hidden. */
export function Notes({ notes }) {
  if (!notes?.length) return null;
  return (
    <aside aria-label="About these numbers" className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" />
      <ul className="space-y-1">{notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </aside>
  );
}

export function RestrictedState({ title = "Analytics aren't available for your role", description = "Ask an administrator if you think you should have access." }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Lock className="size-5" /></span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

export function QueryBoundary({ query, children, skeleton }) {
  if (query.isLoading) return skeleton ?? <div className="space-y-3"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>;
  if (query.error) {
    return query.error?.response?.status === 403
      ? <RestrictedState title="You don't have access to this view" />
      : <ErrorState error={query.error} onRetry={query.refetch} />;
  }
  return <div className={cn("space-y-4 transition-opacity", query.isFetching && "opacity-70")}>{children(query.data)}</div>;
}

/**
 * Date range + team / person / project filters. Options come from endpoints the user can already read, and the
 * server validates every selected filter against the user's scope again.
 */
export function FilterBar({ value, onChange, teams = true, people = true, projects = true }) {
  const { data: teamData } = useTeams({ limit: 100 });
  const { data: peopleData } = usePeople({ limit: 100, sortBy: "name", sortOrder: "asc" });
  const { data: projectData } = useProjects({ limit: 100 });
  const preset = value.preset ?? "30";

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5">
      <Field label="Period" htmlFor="an-period">
        <NativeSelect id="an-period" value={preset} onChange={(event) => onChange({ preset: event.target.value, ...(event.target.value === "custom" ? {} : { from: "", to: "" }) })}>
          {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </NativeSelect>
      </Field>
      {preset === "custom" ? (
        <>
          <Field label="From" htmlFor="an-from"><Input id="an-from" type="date" value={value.from || ""} max={value.to || undefined} onChange={(event) => onChange({ from: event.target.value })} /></Field>
          <Field label="To" htmlFor="an-to"><Input id="an-to" type="date" value={value.to || ""} min={value.from || undefined} onChange={(event) => onChange({ to: event.target.value })} /></Field>
        </>
      ) : null}
      {teams ? (
        <Field label="Team" htmlFor="an-team">
          <NativeSelect id="an-team" value={value.teamId || ""} onChange={(event) => onChange({ teamId: event.target.value })}>
            <option value="">All teams</option>
            {(teamData?.teams ?? []).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {people ? (
        <Field label="Person" htmlFor="an-person">
          <NativeSelect id="an-person" value={value.userId || ""} onChange={(event) => onChange({ userId: event.target.value })}>
            <option value="">Everyone</option>
            {(peopleData?.people ?? []).map((person) => <option key={person.id} value={person.id}>{person.fullName}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {projects ? (
        <Field label="Project" htmlFor="an-project">
          <NativeSelect id="an-project" value={value.projectId || ""} onChange={(event) => onChange({ projectId: event.target.value })}>
            <option value="">All projects</option>
            {(projectData?.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {(value.teamId || value.userId || value.projectId || preset !== "30") ? (
        <div className="flex items-end"><Button variant="ghost" size="sm" onClick={() => onChange({ preset: "30", from: "", to: "", teamId: "", userId: "", projectId: "" })}>Reset filters</Button></div>
      ) : null}
    </div>
  );
}
