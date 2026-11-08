"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Users2,
  UserCheck,
  UserPlus,
  Plus,
  Trash2,
  Loader2,
  Check,
  Search,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { ROLES } from "@/constants/roles";
import {
  useTeam,
  useUpdateTeam,
  useDeleteTeam,
  useAddTeamMember,
  useRemoveTeamMember,
  useSetTeamManager,
  useTeamMemberCandidates,
} from "@/features/teams/hooks/teamHooks";
import { updateTeamSchema } from "@/features/teams/schemas/teamSchemas";

function getInitials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .substring(0, 2);
}

// Highest authority first: org owner/admins, then manager, hr, employee, guest.
const ROLE_RANK = {
  [ROLES.ORG_ADMIN]: 0,
  [ROLES.ADMIN]: 1,
  [ROLES.MANAGER]: 2,
  [ROLES.HR]: 3,
  [ROLES.EMPLOYEE]: 4,
  [ROLES.GUEST]: 5,
};

// The team's manager (lead) always sits in row one, no matter their role
// rank; everyone else below is ordered by role hierarchy, then name.
function sortByRoleHierarchy(members, leadId) {
  return [...members].sort((a, b) => {
    const aIsLead = Boolean(leadId) && a.id === leadId;
    const bIsLead = Boolean(leadId) && b.id === leadId;
    if (aIsLead !== bIsLead) return aIsLead ? -1 : 1;
    const rankA = ROLE_RANK[a.role] ?? 99;
    const rankB = ROLE_RANK[b.role] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return (a.fullName || "").localeCompare(b.fullName || "");
  });
}

function CandidatePicker({ candidates, onPick, isPending, icon: Icon, emptyLabel }) {
  return (
    <div className="max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
      {candidates.length > 0 ? (
        candidates.map((cand) => (
          <div
            key={cand.id}
            className="flex items-center justify-between rounded-lg border border-border p-2.5 hover:bg-muted/50"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Avatar size="sm">
                <AvatarFallback className="text-[11px] font-semibold">{getInitials(cand.fullName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <h4 className="truncate text-xs font-semibold text-foreground">{cand.fullName}</h4>
                <p className="truncate text-[10px] text-muted-foreground capitalize">
                  {cand.role?.replace("-", " ") || "Employee"}
                </p>
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-brand hover:text-brand-hover"
              disabled={isPending}
              onClick={() => onPick(cand.id)}
            >
              <Icon className="size-4" />
            </Button>
          </div>
        ))
      ) : (
        <p className="py-4 text-center text-xs italic text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

export default function TeamRoom({ teamId, onDeleted }) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isLeadOpen, setIsLeadOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState(null);
  const [candidateSearch, setCandidateSearch] = useState("");

  const { data: teamData, isLoading: isTeamLoading, error: teamError } = useTeam(teamId);
  const { data: candidatesData } = useTeamMemberCandidates(
    teamId,
    candidateSearch,
    isLeadOpen ? ROLES.MANAGER : undefined
  );

  const updateTeamMutation = useUpdateTeam(teamId);
  const deleteTeamMutation = useDeleteTeam();
  const addMemberMutation = useAddTeamMember(teamId);
  const removeMemberMutation = useRemoveTeamMember(teamId);
  const setManagerMutation = useSetTeamManager(teamId);

  const team = teamData?.team;
  const candidates = candidatesData?.candidates ?? [];

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm({
    resolver: zodResolver(updateTeamSchema),
    values: {
      name: team?.name ?? "",
      description: team?.description ?? "",
    },
  });

  const onUpdateTeam = (data) => {
    updateTeamMutation.mutate(data);
  };

  const onDeleteTeam = async () => {
    await deleteTeamMutation.mutateAsync(teamId);
    setIsDeleteOpen(false);
    onDeleted?.();
  };

  if (isTeamLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-8 animate-spin text-brand" />
      </div>
    );
  }

  if (teamError || !team) {
    return (
      <div className="space-y-3 py-16 text-center">
        <h2 className="text-xl font-bold text-destructive">Team Room Not Found</h2>
        <p className="text-muted-foreground">The team does not exist or you lack visibility permissions.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5">
        {/* Team Roster */}
        <div className="rounded-xl border border-border/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              <Users2 className="size-3.5 text-brand" /> Team Roster
            </h4>
            <Can permission={PERMISSIONS.MANAGE_TEAM_MEMBERS}>
              <Button onClick={() => setIsAddOpen(true)} size="icon-xs" className="bg-brand hover:bg-brand/90" title="Add member">
                <Plus className="size-3.5" />
              </Button>
            </Can>
          </div>

          {team.members && team.members.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
                    <TableHead className="h-9 pl-3 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Name</TableHead>
                    <TableHead className="h-9 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Role</TableHead>
                    <TableHead className="h-9 pr-3 text-right text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortByRoleHierarchy(team.members, team.lead?.id).map((member) => {
                    const isLead = team.lead && team.lead.id === member.id;
                    return (
                      <TableRow key={member.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                        <TableCell className="py-2.5 pl-3 font-medium">
                          <div className="flex items-center gap-2.5">
                            <Avatar size="sm">
                              <AvatarFallback className="text-[11px]">{getInitials(member.fullName)}</AvatarFallback>
                            </Avatar>
                            <span className="flex items-center gap-1.5 text-sm">
                              {member.fullName}
                              {isLead && (
                                <Badge variant="brand" className="text-[10px] py-0 px-1 font-semibold">
                                  Manager
                                </Badge>
                              )}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2.5 text-xs text-muted-foreground capitalize">
                          {member.role?.replace("-", " ")}
                        </TableCell>
                        <TableCell className="py-2.5 pr-3 text-right">
                          <Can permission={PERMISSIONS.MANAGE_TEAM_MEMBERS}>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:bg-destructive/10"
                              disabled={isLead || removeMemberMutation.isPending}
                              onClick={() => setRemoveCandidate(member)}
                              title={isLead ? "Reassign team manager first" : "Remove member"}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </Can>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border py-8 text-center">
              <p className="text-xs italic text-muted-foreground">No members in this team yet.</p>
            </div>
          )}
        </div>

        {/* Team Leadership */}
        <div className="rounded-xl border border-border/60 p-4">
          <h4 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            <Briefcase className="size-3.5 text-brand" /> Team Leadership
          </h4>
          <div className="flex items-center justify-between gap-3">
            {team.lead ? (
              <div className="flex min-w-0 items-center gap-3">
                <Avatar className="size-10 border-2 border-brand/10">
                  <AvatarFallback className="bg-brand/10 text-sm font-bold text-brand">
                    {getInitials(team.lead.fullName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 space-y-0.5">
                  <h4 className="truncate text-sm font-semibold text-foreground">{team.lead.fullName}</h4>
                  <p className="text-xs capitalize text-muted-foreground">
                    {team.lead.role?.replace("-", " ") || "Team Manager"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs italic text-muted-foreground">No manager assigned yet.</p>
            )}

            <Can permission={PERMISSIONS.MANAGE_TEAM_MEMBERS}>
              <Button variant="outline" size="sm" onClick={() => setIsLeadOpen(true)} className="shrink-0 gap-1.5 text-xs">
                <UserCheck className="size-3.5" /> Change
              </Button>
            </Can>
          </div>
        </div>

        {/* Team Settings */}
        <Can permission={PERMISSIONS.UPDATE_TEAM}>
          <form
            onSubmit={handleSubmit(onUpdateTeam)}
            className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4"
          >
            <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Team Settings</h4>

            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Team Name</label>
              <Input {...register("name")} placeholder="e.g. Sales Division" className="bg-background" />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Description</label>
              <Textarea
                {...register("description")}
                placeholder="Provide details about the team's objectives..."
                className="min-h-[80px] resize-none bg-background"
              />
              {errors.description && <p className="text-xs text-destructive">{errors.description.message}</p>}
            </div>

            <div className="flex justify-end border-t border-border/60 pt-3">
              <Button
                type="submit"
                size="sm"
                disabled={!isDirty || updateTeamMutation.isPending}
                className="bg-brand hover:bg-brand/90"
              >
                {updateTeamMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </Can>

        {/* Danger zone */}
        <Can permission={PERMISSIONS.DELETE_TEAM}>
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Permanently delete this team. This clears the primary team assignment for every member on its roster.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setIsDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              Delete Team
            </Button>
          </div>
        </Can>
      </div>

      {/* Add Teammate Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="w-[95vw] gap-0 p-0 sm:max-w-md">
          <DialogHeader className="gap-3 p-6 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                <UserPlus className="size-5" />
              </span>
              <DialogTitle className="text-base">Add Team Member</DialogTitle>
            </div>
            <DialogDescription>Search and add eligible organization users to this team.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-6 pb-6">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={candidateSearch}
                onChange={(e) => setCandidateSearch(e.target.value)}
                placeholder="Search candidates by name or email..."
                className="pl-9"
              />
            </div>
            <CandidatePicker
              candidates={candidates}
              isPending={addMemberMutation.isPending}
              icon={Plus}
              emptyLabel="No matching candidates found."
              onPick={async (id) => {
                await addMemberMutation.mutateAsync(id);
                setIsAddOpen(false);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Change Manager Dialog */}
      <Dialog open={isLeadOpen} onOpenChange={setIsLeadOpen}>
        <DialogContent className="w-[95vw] gap-0 p-0 sm:max-w-md">
          <DialogHeader className="gap-3 p-6 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                <UserCheck className="size-5" />
              </span>
              <DialogTitle className="text-base">Assign Team Manager</DialogTitle>
            </div>
            <DialogDescription>Choose an active user with the Manager role to serve as team lead.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-6 pb-6">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={candidateSearch}
                onChange={(e) => setCandidateSearch(e.target.value)}
                placeholder="Search candidates..."
                className="pl-9"
              />
            </div>
            <CandidatePicker
              candidates={candidates}
              isPending={setManagerMutation.isPending}
              icon={Check}
              emptyLabel="No eligible candidates with the Manager role."
              onPick={async (id) => {
                await setManagerMutation.mutateAsync(id);
                setIsLeadOpen(false);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove Member confirmation */}
      <Dialog open={Boolean(removeCandidate)} onOpenChange={(next) => !next && setRemoveCandidate(null)}>
        <DialogContent className="w-[95vw] gap-0 p-0 sm:max-w-md">
          {removeCandidate && (
            <>
              <DialogHeader className="gap-3 p-6 pb-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                    <Trash2 className="size-5" />
                  </span>
                  <DialogTitle className="text-base">Remove {removeCandidate.fullName}?</DialogTitle>
                </div>
                <DialogDescription>They&apos;ll be removed from this team&apos;s roster immediately.</DialogDescription>
              </DialogHeader>
              <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRemoveCandidate(null)}
                  disabled={removeMemberMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="gap-2 bg-red-600 hover:bg-red-700"
                  disabled={removeMemberMutation.isPending}
                  onClick={async () => {
                    await removeMemberMutation.mutateAsync(removeCandidate.id);
                    setRemoveCandidate(null);
                  }}
                >
                  {removeMemberMutation.isPending && <Loader2 className="size-4 animate-spin" />}
                  Remove
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Team confirmation */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="w-[95vw] gap-0 p-0 sm:max-w-md">
          <DialogHeader className="gap-3 p-6 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <Users2 className="size-5" />
              </span>
              <DialogTitle className="text-base">Delete this team?</DialogTitle>
            </div>
            <DialogDescription>
              This is permanent and clears the primary team assignment for every member on its roster.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
            <Button type="button" variant="outline" onClick={() => setIsDeleteOpen(false)} disabled={deleteTeamMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-red-600 hover:bg-red-700"
              disabled={deleteTeamMutation.isPending}
              onClick={onDeleteTeam}
            >
              {deleteTeamMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              Delete Team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
