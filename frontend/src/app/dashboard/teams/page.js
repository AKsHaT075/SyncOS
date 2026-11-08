"use client";

import { useEffect, useState } from "react";
import {
  Search,
  Plus,
  Users2,
  AlertCircle,
  ArrowRight,
  LayoutGrid,
  List,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import NewTeamModal from "@/components/teams/NewTeamModal";
import TeamDetailDialog from "@/features/teams/components/TeamDetailDialog";

export default function ManageTeamsPage() {
  const [view, setView] = useState("table");
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [isNewTeamOpen, setIsNewTeamOpen] = useState(false);
  const [page, setPage] = useState(1);

  const search = useDebouncedValue(searchInput);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const { data: teamsData, isLoading: isTeamsLoading, isError: isTeamsError } = useTeams({
    page,
    limit: 20,
    ...(search && { search }),
  });

  const teams = teamsData?.teams ?? [];
  const pagination = teamsData?.pagination;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/95">
      <div className="space-y-6 p-6 max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Manage Teams</h1>
            <p className="text-sm text-muted-foreground">Organization groups, departments, and rosters</p>
          </div>
          <Can permission={PERMISSIONS.CREATE_TEAM}>
            <Button onClick={() => setIsNewTeamOpen(true)} className="gap-2 bg-brand hover:bg-brand/90">
              <Plus className="size-4" /> New Team
            </Button>
          </Can>
        </div>

        {/* Filters Panel */}
        <div className="space-y-3 rounded-lg border border-border bg-card p-4 backdrop-blur-sm shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search teams by name..."
                className="pl-9 bg-background/50"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-background/50 p-1 self-end sm:self-auto">
              <Button variant={view === "table" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setView("table")} title="Table view">
                <List className="size-4" />
              </Button>
              <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setView("grid")} title="Grid view">
                <LayoutGrid className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Teams list */}
        {isTeamsLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : isTeamsError ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={AlertCircle}
              title="Couldn't load teams"
              description="Please try again in a moment."
            />
          </Card>
        ) : teams.length === 0 ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={Users2}
              title="No teams found"
              description="No organization teams match the current criteria."
            />
          </Card>
        ) : view === "table" ? (
          <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
                  <TableHead className="h-11 pl-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Name</TableHead>
                  <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Manager</TableHead>
                  <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Description</TableHead>
                  <TableHead className="h-11 pr-5 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Members</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.map((team) => (
                  <TableRow
                    key={team.id}
                    className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30"
                    onClick={() => setSelectedTeamId(team.id)}
                  >
                    <TableCell className="py-3.5 pl-5 font-medium">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                          <Users2 className="size-4" />
                        </div>
                        <span className="text-foreground transition-colors hover:text-brand hover:underline hover:underline-offset-2">
                          {team.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="py-3.5 text-sm text-muted-foreground">
                      {team.lead?.fullName || <span className="italic">Unassigned</span>}
                    </TableCell>
                    <TableCell className="py-3.5 text-sm text-muted-foreground">
                      <span className="line-clamp-1">{team.description || <span className="italic">No description</span>}</span>
                    </TableCell>
                    <TableCell className="py-3.5 pr-5 text-right">
                      <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 font-medium">
                        {team.memberCount}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((team) => (
              <button
                type="button"
                key={team.id}
                className="block h-full text-left group"
                onClick={() => setSelectedTeamId(team.id)}
              >
                <Card className="p-5 h-full border border-border bg-card hover:shadow-md transition-all group-hover:border-brand/30 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="size-10 rounded-lg bg-brand/10 text-brand flex items-center justify-center group-hover:bg-brand group-hover:text-brand-foreground transition-all">
                        <Users2 className="size-5" />
                      </div>
                      <Badge variant="secondary">{team.memberCount} Members</Badge>
                    </div>

                    <div>
                      <h3 className="font-semibold text-foreground group-hover:text-brand transition-colors">
                        {team.name}
                      </h3>
                      <p className="text-xs text-muted-foreground line-clamp-2 min-h-8 mt-1">
                        {team.description || "No description listed."}
                      </p>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border mt-4 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Manager: <strong>{team.lead?.fullName || "Unassigned"}</strong></span>
                    <span className="text-brand group-hover:translate-x-1 transition-transform inline-flex items-center gap-1 font-medium">
                      View Room <ArrowRight className="size-3" />
                    </span>
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Page <span className="font-semibold">{pagination.page}</span> of <span className="font-semibold">{pagination.pages}</span> ·
              <span className="font-semibold ml-1">{pagination.total}</span> teams
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(p + 1, pagination.pages))}
                disabled={page === pagination.pages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      <NewTeamModal isOpen={isNewTeamOpen} onClose={() => setIsNewTeamOpen(false)} />
      <TeamDetailDialog
        teamId={selectedTeamId}
        open={Boolean(selectedTeamId)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedTeamId(null);
        }}
      />
    </div>
  );
}
