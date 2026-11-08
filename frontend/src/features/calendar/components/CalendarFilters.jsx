"use client";

import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SCOPES } from "@/features/calendar/constants/calendarOptions";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { usePeople } from "@/features/people/hooks/usePeople";

const ANY = "any";

/** Scope (personal / team / organization) plus project, assignee and status filters. */
export default function CalendarFilters({ filters, onChange, onReset }) {
  const { data: teamsData } = useTeams({ limit: 100 });
  const { data: projectsData } = useProjects({ limit: 100 });
  const { data: peopleData } = usePeople({ limit: 100 });
  const teams = teamsData?.teams ?? [];
  const projects = projectsData?.projects ?? [];
  const people = (peopleData?.people ?? []).filter((person) => person.isActive);
  const active = filters.projectId || filters.assigneeId || filters.status || filters.includeCancelled;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label="Filters">
          <SlidersHorizontal className="size-4" />Filters
          {active ? <span className="size-2 rounded-full bg-primary" aria-label="Filters applied" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,22rem)] space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">Calendar</p>
          <Tabs value={filters.scope} onValueChange={(scope) => onChange({ scope })}>
            <TabsList className="w-full">
              {SCOPES.map((scope) => <TabsTrigger key={scope.value} value={scope.value}>{scope.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">{SCOPES.find((scope) => scope.value === filters.scope)?.description}</p>
        </div>

        {filters.scope === "team" ? (
          <div className="space-y-1.5">
            <label htmlFor="cal-team" className="text-xs font-medium text-foreground">Team</label>
            <Select value={filters.teamId || ANY} onValueChange={(value) => onChange({ teamId: value === ANY ? "" : value })}>
              <SelectTrigger id="cal-team" className="w-full"><SelectValue placeholder="Choose a team" /></SelectTrigger>
              <SelectContent>
                {teams.length === 0 ? <SelectItem value={ANY} disabled>No teams available</SelectItem> : null}
                {teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="cal-project" className="text-xs font-medium text-foreground">Project</label>
          <Select value={filters.projectId || ANY} onValueChange={(value) => onChange({ projectId: value === ANY ? "" : value })}>
            <SelectTrigger id="cal-project" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All projects</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="cal-assignee" className="text-xs font-medium text-foreground">Person (assignee, host or attendee)</label>
          <Select value={filters.assigneeId || ANY} onValueChange={(value) => onChange({ assigneeId: value === ANY ? "" : value })}>
            <SelectTrigger id="cal-assignee" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Anyone</SelectItem>
              {people.map((person) => <SelectItem key={person.id} value={person.id}>{person.fullName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="cal-status" className="text-xs font-medium text-foreground">Status</label>
          <Select value={filters.status || ANY} onValueChange={(value) => onChange({ status: value === ANY ? "" : value })}>
            <SelectTrigger id="cal-status" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {["Todo", "In Progress", "In Review", "Completed", "Scheduled", "Active", "Ended"].map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          Show cancelled meetings
          <Switch checked={filters.includeCancelled} onCheckedChange={(value) => onChange({ includeCancelled: value })} aria-label="Show cancelled meetings" />
        </label>

        <Button variant="ghost" size="sm" onClick={onReset} className="w-full">Reset filters</Button>
      </PopoverContent>
    </Popover>
  );
}
