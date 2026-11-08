"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import {
  Mail,
  Users,
  Clock,
  Loader2,
  Ban,
  ShieldCheck,
  KeyRound,
  UserMinus,
  Sparkles,
  Pencil,
  Check,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useAuthStore } from "@/store/useAuthStore";
import { usePerson } from "@/features/people/hooks/usePerson";
import { useUpdatePerson } from "@/features/people/hooks/useUpdatePerson";
import { useRemovePerson } from "@/features/people/hooks/useRemovePerson";
import { useForcePasswordReset } from "@/features/people/hooks/useForcePasswordReset";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { ROLES, ASSIGNABLE_ROLES, ORG_ADMIN_BADGE_CLASS } from "@/constants/roles";

function getInitials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .substring(0, 2);
}

// Config for the second-step confirmation popup, keyed by the action a
// caller wants to take. Centralized here so every sensitive people-admin
// action gets the same look instead of a native browser confirm().
const CONFIRM_CONFIG = {
  role: (person, role) => ({
    icon: ShieldCheck,
    iconClassName: "bg-violet-50 text-violet-600",
    title: `Change role to ${role.replace("-", " ")}?`,
    description: `${person.fullName} will immediately gain the permissions of this role.`,
    confirmLabel: "Change Role",
    confirmClassName: "bg-violet-600 hover:bg-violet-700",
  }),
  block: (person) => ({
    icon: Ban,
    iconClassName: "bg-amber-50 text-amber-600",
    title: "Block from this organization?",
    description: `${person.fullName} keeps their account but loses all access to this organization immediately.`,
    confirmLabel: "Block User",
    confirmClassName: "bg-amber-600 hover:bg-amber-700",
  }),
  unblock: (person) => ({
    icon: Ban,
    iconClassName: "bg-emerald-50 text-emerald-600",
    title: "Restore organization access?",
    description: `${person.fullName} will immediately regain full access to this organization.`,
    confirmLabel: "Unblock User",
    confirmClassName: "bg-emerald-600 hover:bg-emerald-700",
  }),
  forceReset: (person) => ({
    icon: KeyRound,
    iconClassName: "bg-blue-50 text-blue-600",
    title: "Force a password reset?",
    description: `All of ${person.fullName}'s active sessions are revoked immediately and they'll be emailed a link to set a new password.`,
    confirmLabel: "Revoke & Send Reset",
    confirmClassName: "bg-blue-600 hover:bg-blue-700",
  }),
  remove: (person) => ({
    icon: UserMinus,
    iconClassName: "bg-red-50 text-red-600",
    title: "Remove from this organization?",
    description: `${person.fullName} loses all access, team memberships, and org data association immediately. Their account itself isn't deleted — but this can't be undone from here.`,
    confirmLabel: "Remove User",
    confirmClassName: "bg-red-600 hover:bg-red-700",
  }),
};

export default function PersonDetailDialog({ userId, open, onOpenChange }) {
  const actor = useAuthStore((state) => state.user);
  const { data: personData, isLoading, error } = usePerson(userId);
  const { data: teamsData } = useTeams({ limit: 100 });
  const updatePersonMutation = useUpdatePerson(userId);
  const removePersonMutation = useRemovePerson();
  const forceResetMutation = useForcePasswordReset();
  const [confirmAction, setConfirmAction] = useState(null);
  const [isEditingSkills, setIsEditingSkills] = useState(false);
  const [skillsDraft, setSkillsDraft] = useState("");

  const targetPerson = personData?.person;
  const teams = teamsData?.teams ?? [];

  const isSelf = Boolean(actor && targetPerson && actor.id === targetPerson.id);
  const canManage = Boolean(targetPerson?.canManage) && !isSelf;
  const isOrgAdmin = actor?.role === ROLES.ORG_ADMIN || actor?.role === ROLES.ADMIN;
  const canWieldAdminPowers = canManage && isOrgAdmin;

  const {
    handleSubmit,
    setValue,
    watch,
    formState: { isDirty },
  } = useForm({
    values: {
      teamId: targetPerson?.team?.id ?? "",
    },
  });

  const watchTeamId = watch("teamId");

  const onSubmit = (data) => {
    updatePersonMutation.mutate({
      teamId: data.teamId === "" ? null : data.teamId,
    });
  };

  const startEditingSkills = () => {
    setSkillsDraft(targetPerson?.skills?.join(", ") ?? "");
    setIsEditingSkills(true);
  };

  const cancelEditingSkills = () => setIsEditingSkills(false);

  const saveSkills = () => {
    const skills = skillsDraft
      .split(",")
      .map((skill) => skill.trim())
      .filter(Boolean);
    updatePersonMutation.mutate({ skills }, { onSuccess: () => setIsEditingSkills(false) });
  };

  const closeConfirm = () => setConfirmAction(null);

  const handleConfirm = () => {
    if (!confirmAction) return;
    switch (confirmAction.type) {
      case "role":
        updatePersonMutation.mutate({ role: confirmAction.role }, { onSuccess: closeConfirm });
        break;
      case "block":
        updatePersonMutation.mutate({ orgBlocked: true }, { onSuccess: closeConfirm });
        break;
      case "unblock":
        updatePersonMutation.mutate({ orgBlocked: false }, { onSuccess: closeConfirm });
        break;
      case "forceReset":
        forceResetMutation.mutate(userId, { onSuccess: closeConfirm });
        break;
      case "remove":
        removePersonMutation.mutate(userId, {
          onSuccess: () => {
            closeConfirm();
            onOpenChange(false);
          },
        });
        break;
      default:
        break;
    }
  };

  const isConfirmPending =
    updatePersonMutation.isPending || forceResetMutation.isPending || removePersonMutation.isPending;

  const confirmConfig = confirmAction && targetPerson
    ? CONFIRM_CONFIG[confirmAction.type](targetPerson, confirmAction.role)
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[95vw] max-h-[85vh] gap-0 overflow-y-auto p-0 shadow-2xl sm:max-w-lg">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-6 animate-spin text-brand" />
            </div>
          ) : error || !targetPerson ? (
            <div className="space-y-3 px-6 py-16 text-center">
              <h2 className="text-base font-semibold text-destructive">User Profile Not Found</h2>
              <p className="text-sm text-muted-foreground">
                This user does not exist or you lack visibility permission.
              </p>
            </div>
          ) : (
            <>
              <DialogHeader className="gap-3 border-b border-border/40 bg-muted/20 px-6 pt-7 pb-5">
                <div className="flex items-center gap-3">
                  <Avatar className="size-14 shrink-0 ring-2 ring-brand/15">
                    <AvatarFallback className="bg-brand/10 text-lg font-bold text-brand">
                      {getInitials(targetPerson.fullName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <DialogTitle className="truncate text-lg">{targetPerson.fullName}</DialogTitle>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`capitalize ${targetPerson.role === ROLES.ORG_ADMIN ? ORG_ADMIN_BADGE_CLASS : ""}`}
                      >
                        {targetPerson.role?.replace("-", " ")}
                      </Badge>
                      {targetPerson.orgBlocked && (
                        <Badge variant="destructive" className="gap-1">
                          <Ban className="size-3" /> Blocked
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <DialogDescription className="sr-only">Profile details for {targetPerson.fullName}</DialogDescription>
              </DialogHeader>

              <div className="space-y-5 px-6 py-6">
                <div className="space-y-2 text-sm">
                  {targetPerson.email && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Mail className="size-4 shrink-0" />
                      <span className="truncate">{targetPerson.email}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="size-4 shrink-0" />
                    <span>{targetPerson.team?.name || "No Team Assigned"}</span>
                  </div>
                  {targetPerson.createdAt && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="size-4 shrink-0" />
                      <span>Joined {new Date(targetPerson.createdAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                      Skills & Expertise
                    </h4>
                    {canManage && !isEditingSkills && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={startEditingSkills}
                        title="Edit skills"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                  </div>

                  {isEditingSkills ? (
                    <div className="space-y-2">
                      <Input
                        value={skillsDraft}
                        onChange={(e) => setSkillsDraft(e.target.value)}
                        placeholder="React, TypeScript, CSS, Node.js"
                        className="bg-background"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          onClick={cancelEditingSkills}
                          disabled={updatePersonMutation.isPending}
                        >
                          <X className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          className="bg-brand hover:bg-brand/90"
                          onClick={saveSkills}
                          disabled={updatePersonMutation.isPending}
                        >
                          {updatePersonMutation.isPending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : targetPerson.skills && targetPerson.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {targetPerson.skills.map((skill) => (
                        <Badge key={skill} variant="secondary">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No skills listed yet.</p>
                  )}
                </div>

                {canManage && (
                  <form
                    onSubmit={handleSubmit(onSubmit)}
                    className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4"
                  >
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                      <Sparkles className="size-3.5 text-brand" /> Manage Profile
                    </h4>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-foreground">Assigned Team</label>
                      <Select
                        value={watchTeamId || ""}
                        onValueChange={(val) => setValue("teamId", val, { shouldDirty: true })}
                      >
                        <SelectTrigger className="w-full bg-background">
                          <SelectValue placeholder="Select a team" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None / Unassigned</SelectItem>
                          {teams.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-2 bg-background"
                        disabled={forceResetMutation.isPending}
                        onClick={() => setConfirmAction({ type: "forceReset" })}
                      >
                        <KeyRound className="size-4" />
                        Force Password Reset
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!isDirty || updatePersonMutation.isPending}
                        className="bg-brand hover:bg-brand/90"
                      >
                        {updatePersonMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                        Save Changes
                      </Button>
                    </div>
                  </form>
                )}

                {canWieldAdminPowers && (
                  <div className="space-y-3 rounded-xl border border-border/60 p-4">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                      <ShieldCheck className="size-3.5 text-brand" /> Admin Actions
                    </h4>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-foreground">Role</label>
                      <Select
                        value={targetPerson.role}
                        onValueChange={(role) => {
                          if (role === targetPerson.role) return;
                          setConfirmAction({ type: "role", role });
                        }}
                      >
                        <SelectTrigger className="w-full bg-background">
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_ROLES.map((role) => (
                            <SelectItem key={role} value={role} className="capitalize">
                              {role.replace("-", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border bg-background p-3">
                      <div className="flex items-center gap-2">
                        <Ban className="size-4 text-muted-foreground" />
                        <div className="space-y-0.5">
                          <label htmlFor="org-blocked-switch" className="text-xs font-medium text-foreground">
                            Block from organization
                          </label>
                          <p className="text-xs text-muted-foreground">
                            {targetPerson.orgBlocked
                              ? "Blocked — they keep their account but have no access here."
                              : "They currently have full access to this organization."}
                          </p>
                        </div>
                      </div>
                      <Switch
                        id="org-blocked-switch"
                        checked={targetPerson.orgBlocked}
                        disabled={updatePersonMutation.isPending}
                        onCheckedChange={(nextBlocked) =>
                          setConfirmAction({ type: nextBlocked ? "block" : "unblock" })
                        }
                      />
                    </div>

                    <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                      <p className="mb-2 text-xs text-muted-foreground">
                        Permanently remove this person from the organization. Their account remains, but all org
                        access and team membership is revoked.
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={removePersonMutation.isPending}
                        onClick={() => setConfirmAction({ type: "remove" })}
                      >
                        <UserMinus className="size-4" />
                        Remove from Organization
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmAction)} onOpenChange={(next) => !next && closeConfirm()}>
        <DialogContent className="w-[95vw] gap-0 p-0 sm:max-w-md">
          {confirmConfig && (
            <>
              <DialogHeader className="gap-3 p-6 pb-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${confirmConfig.iconClassName}`}
                  >
                    <confirmConfig.icon className="size-5" />
                  </span>
                  <div>
                    <DialogTitle className="text-base">{confirmConfig.title}</DialogTitle>
                  </div>
                </div>
                <DialogDescription>{confirmConfig.description}</DialogDescription>
              </DialogHeader>

              <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
                <Button type="button" variant="outline" onClick={closeConfirm} disabled={isConfirmPending}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isConfirmPending}
                  className={`gap-2 ${confirmConfig.confirmClassName}`}
                >
                  {isConfirmPending && <Loader2 className="size-4 animate-spin" />}
                  {confirmConfig.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
