"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useAddProjectMember, useRemoveProjectMember, useUpdateProjectMemberRole } from "@/features/projects/hooks/useProjectMembers";
import { useProjectMemberCandidates } from "@/features/projects/hooks/useProjectMemberCandidates";
import { PROJECT_MEMBER_ROLES } from "@/features/projects/constants/projectOptions";
import { canManageProjectClient } from "@/features/projects/utils/permissions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function AddMemberPopover({ projectId }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const { data, isFetching } = useProjectMemberCandidates(projectId, debouncedSearch, open);
  const addMutation = useAddProjectMember(projectId);
  const candidates = data?.candidates || [];

  const handleAdd = (userId) => {
    addMutation.mutate(
      { userId, role: "Contributor" },
      { onSuccess: () => setOpen(false) }
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm">
          <UserPlus className="mr-1.5 size-4" />
          Add member
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
        <div className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
          {isFetching ? (
            <p className="p-2 text-xs text-muted-foreground">Searching...</p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No matching users found.</p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => handleAdd(candidate.id)}
                disabled={addMutation.isPending}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent"
              >
                <Avatar size="sm">
                  <AvatarFallback>{initials(candidate.fullName)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{candidate.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{candidate.email}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function ProjectMembersPage() {
  const { projectId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data, isLoading } = useProject(projectId);
  const updateRoleMutation = useUpdateProjectMemberRole(projectId);
  const removeMutation = useRemoveProjectMember(projectId);

  const project = data?.project;
  const canManage = canManageProjectClient(project, authUser);

  if (isLoading || !project) {
    return (
      <DashboardCard>
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      </DashboardCard>
    );
  }

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Users}
        iconClassName="bg-violet-50 text-violet-600"
        title="Members"
        description={`${project.memberCount} people on this project.`}
        action={canManage ? <AddMemberPopover projectId={projectId} /> : null}
      />

      {project.members.length === 0 ? (
        <div className="mt-5">
          <EmptyStateCard icon={Users} title="No members yet" description="Add teammates to collaborate on this project." />
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          {project.members.map((member) => {
            const isOwner = member.role === "Owner";
            return (
              <div
                key={member.user?.id}
                className="flex items-center justify-between gap-3 rounded-xl p-3 transition-colors hover:bg-zinc-50"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="size-9 shrink-0 font-semibold text-xs">
                    <AvatarFallback className="bg-gradient-to-br from-violet-100 to-purple-100 text-zinc-700">
                      {initials(member.user?.fullName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">{member.user?.fullName || "Unknown"}</p>
                    <p className="truncate text-xs text-zinc-500">{member.user?.email}</p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {canManage && !isOwner ? (
                    <Select
                      value={member.role}
                      onValueChange={(role) => updateRoleMutation.mutate({ userId: member.user?.id, role })}
                    >
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_MEMBER_ROLES.filter((role) => role !== "Owner").map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary" className="font-medium">
                      {member.role}
                    </Badge>
                  )}

                  {canManage && !isOwner ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-zinc-400 hover:text-destructive"
                      onClick={() => removeMutation.mutate(member.user?.id)}
                      disabled={removeMutation.isPending}
                      aria-label="Remove member"
                    >
                      <X className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardCard>
  );
}
