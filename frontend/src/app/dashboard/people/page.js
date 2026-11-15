"use client";

import { useEffect, useState } from "react";
import {
  Search,
  LayoutGrid,
  List,
  UserPlus,
  Users,
  AlertCircle,
  Activity,
  CheckCircle,
  Briefcase,
  Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import InviteTeammateDialog from "@/components/dashboard/InviteTeammateDialog";
import { useAuthStore } from "@/store/useAuthStore";
import { ROLES, ORG_ADMIN_TEXT_CLASS } from "@/constants/roles";
import { usePeople } from "@/features/people/hooks/usePeople";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import PersonDetailDialog from "@/features/people/components/PersonDetailDialog";

const ALL = "all";

export default function PeopleDirectoryPage() {
  // The invitations API is limited to the organization owner and admins (HR can manage people but not invite).
  const canInvite = useAuthStore((state) => [ROLES.ORG_ADMIN, ROLES.ADMIN].includes(state.user?.role));
  const [view, setView] = useState("table");
  const [selectedPersonId, setSelectedPersonId] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [role, setRole] = useState(ALL);
  const [team, setTeam] = useState(ALL);
  const [sortBy, setSortBy] = useState("role");
  const [sortOrder, setSortOrder] = useState("asc");
  const [page, setPage] = useState(1);

  const search = useDebouncedValue(searchInput);

  useEffect(() => {
    setPage(1);
  }, [search, role, team, sortBy, sortOrder]);

  const { data: peopleData, isLoading: isPeopleLoading, isError: isPeopleError } = usePeople({
    page,
    limit: 20,
    sortBy,
    sortOrder,
    ...(search && { search }),
    ...(role !== ALL && { role }),
    ...(team !== ALL && { team }),
  });

  const { data: teamsData } = useTeams({ limit: 100 });

  const people = peopleData?.people ?? [];
  const pagination = peopleData?.pagination;
  const teams = teamsData?.teams ?? [];

  const getInitials = (name) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .substring(0, 2);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/95">
      <div className="space-y-6 p-6 max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">People</h1>
            <p className="text-sm text-muted-foreground">Directory of colleagues and teams</p>
          </div>
          {canInvite && (
            <InviteTeammateDialog>
              <Button className="gap-2 bg-brand hover:bg-brand/90">
                <UserPlus className="size-4" /> Invite Teammate
              </Button>
            </InviteTeammateDialog>
          )}
        </div>

        {/* Filters Panel */}
        <div className="space-y-3 rounded-lg border border-border bg-card p-4 backdrop-blur-sm shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by name or email..."
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

          <div className="flex flex-wrap gap-2 items-center">
            {/* Role Filter */}
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger size="sm" className="w-[140px] bg-background/50">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Roles</SelectItem>
                {Object.entries(ROLES).map(([key, value]) => (
                  <SelectItem key={value} value={value}>
                    {key.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Team Filter */}
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger size="sm" className="w-[160px] bg-background/50">
                <SelectValue placeholder="Team" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Teams</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Sort Filter */}
            <Select value={`${sortBy}-${sortOrder}`} onValueChange={(val) => {
              const [by, order] = val.split("-");
              setSortBy(by);
              setSortOrder(order);
            }}>
              <SelectTrigger size="sm" className="w-[180px] bg-background/50">
                <SelectValue placeholder="Sort By" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                <SelectItem value="role-asc">Role (Top-Down)</SelectItem>
                <SelectItem value="role-desc">Role (Bottom-Up)</SelectItem>
                <SelectItem value="createdAt-desc">Date Joined (Newest)</SelectItem>
                <SelectItem value="createdAt-asc">Date Joined (Oldest)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content list */}
        {isPeopleLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-48 w-full rounded-lg" />
            ))}
          </div>
        ) : isPeopleError ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={AlertCircle}
              title="Couldn't load directory"
              description="Please try again in a moment."
            />
          </Card>
        ) : people.length === 0 ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={Users}
              title="No people found"
              description="No members match the selected filters."
            />
          </Card>
        ) : view === "table" ? (
          <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
                  <TableHead className="h-11 pl-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Name</TableHead>
                  <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Email</TableHead>
                  <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Role</TableHead>
                  <TableHead className="h-11 pr-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Team</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((person) => {
                  const isOrgAdmin = person.role === ROLES.ORG_ADMIN;
                  return (
                    <TableRow
                      key={person.id}
                      className={`cursor-pointer border-b border-border/60 transition-colors last:border-0 ${
                        isOrgAdmin
                          ? "border-l-2 border-l-violet-500 bg-violet-50/70 hover:bg-violet-50"
                          : "hover:bg-muted/30"
                      }`}
                      onClick={() => setSelectedPersonId(person.id)}
                    >
                      <TableCell className="py-3.5 pl-5 font-medium">
                        <div className="flex items-center gap-3">
                          <Avatar size="sm" className={isOrgAdmin ? "ring-1 ring-violet-200" : "ring-1 ring-border"}>
                            <AvatarFallback
                              className={`text-[11px] font-semibold ${
                                isOrgAdmin ? "bg-violet-100 text-violet-700" : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {getInitials(person.fullName)}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={`flex items-center gap-1 transition-colors hover:underline hover:underline-offset-2 ${
                              isOrgAdmin ? "font-semibold text-violet-700 hover:text-violet-800" : "text-foreground hover:text-brand"
                            }`}
                          >
                            {isOrgAdmin && <Crown className="size-3.5 fill-violet-500 text-violet-500" />}
                            {person.fullName}
                          </span>
                          {person.orgBlocked && (
                            <Badge variant="destructive" className="text-[10px]">
                              Blocked
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-3.5 text-sm text-muted-foreground">
                        {person.email || <span className="italic">Gated</span>}
                      </TableCell>
                      <TableCell
                        className={`py-3.5 text-sm capitalize ${isOrgAdmin ? "font-medium text-violet-600" : "text-muted-foreground"}`}
                      >
                        {person.role?.replace("-", " ")}
                      </TableCell>
                      <TableCell className="py-3.5 pr-5 text-sm text-muted-foreground">
                        {person.team?.name || <span className="italic">No Team</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {people.map((person) => (
              <button
                type="button"
                key={person.id}
                className="block h-full text-left group"
                onClick={() => setSelectedPersonId(person.id)}
              >
                <Card className="p-5 h-full hover:shadow-md transition-all border border-border group-hover:border-brand/30 flex flex-col justify-between">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <Avatar className="size-12 ring-2 ring-transparent group-hover:ring-brand/20 transition-all">
                        <AvatarFallback className="bg-brand/10 text-brand text-sm font-semibold">
                          {getInitials(person.fullName)}
                        </AvatarFallback>
                      </Avatar>
                      {person.orgBlocked && <Badge variant="destructive">Blocked</Badge>}
                    </div>

                    <div>
                      <h3 className="font-semibold text-foreground group-hover:text-brand transition-colors">
                        {person.fullName}
                      </h3>
                      <p className="text-xs text-muted-foreground truncate">{person.email || "No email"}</p>
                    </div>

                    <div className="space-y-1.5 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Briefcase className="size-3.5" />
                        <span className={`capitalize ${person.role === ROLES.ORG_ADMIN ? ORG_ADMIN_TEXT_CLASS : ""}`}>
                          {person.role?.replace("-", " ")}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Users className="size-3.5" />
                        <span>{person.team?.name || "No Team"}</span>
                      </div>
                    </div>
                  </div>

                  {person.skills && person.skills.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1 pt-3 border-t border-border">
                      {person.skills.slice(0, 3).map((skill) => (
                        <Badge key={skill} variant="outline" className="text-[10px] py-0 px-1.5 font-normal">
                          {skill}
                        </Badge>
                      ))}
                      {person.skills.length > 3 && (
                        <span className="text-[10px] text-muted-foreground self-center">+{person.skills.length - 3} more</span>
                      )}
                    </div>
                  )}
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
              <span className="font-semibold ml-1">{pagination.total}</span> members
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

      <PersonDetailDialog
        userId={selectedPersonId}
        open={Boolean(selectedPersonId)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedPersonId(null);
        }}
      />
    </div>
  );
}
