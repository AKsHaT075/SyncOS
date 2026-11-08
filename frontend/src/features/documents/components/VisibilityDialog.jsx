"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/store/useAuthStore";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { useUpdateDocument } from "@/features/documents/hooks/documentHooks";
import { ORG_WIDE_PUBLISH_ROLES, VISIBILITY_OPTIONS } from "@/features/documents/constants/documentOptions";

export default function VisibilityDialog({ open, onOpenChange, document: doc }) {
  const role = useAuthStore((state) => state.role);
  const [visibility, setVisibility] = useState("private");
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const update = useUpdateDocument();
  const { data: teamsData } = useTeams({ limit: 100 });
  const { data: projectsData } = useProjects({ limit: 100 });

  const teams = teamsData?.teams ?? [];
  const projects = (projectsData?.projects ?? []).filter((p) => p.myRole || role === "org-admin" || role === "admin");

  useEffect(() => {
    if (open && doc) {
      setVisibility(doc.visibility);
      setTeamId(doc.team?.id ?? "");
      setProjectId(doc.project?.id ?? "");
    }
  }, [open, doc]);

  const missingTarget = (visibility === "team" && !teamId) || (visibility === "project" && !projectId);

  const save = async () => {
    try {
      await update.mutateAsync({
        id: doc.id,
        updates: {
          visibility,
          ...(visibility === "team" ? { teamId } : {}),
          ...(visibility === "project" ? { projectId } : {}),
        },
      });
      onOpenChange(false);
    } catch {
      /* toast already shown */
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !update.isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Who can access “{doc?.name}”</DialogTitle>
          <DialogDescription>Access follows current team and project membership, so people who leave lose it automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="vis-select" className="text-xs font-medium text-foreground">Visibility</label>
            <Select value={visibility} onValueChange={setVisibility}>
              <SelectTrigger id="vis-select" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} disabled={option.value === "organization" && !ORG_WIDE_PUBLISH_ROLES.includes(role)}>
                    {option.label} — {option.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {visibility === "team" ? (
            <div className="space-y-1.5">
              <label htmlFor="vis-team" className="text-xs font-medium text-foreground">Team</label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id="vis-team" className="w-full"><SelectValue placeholder="Choose a team" /></SelectTrigger>
                <SelectContent>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
          {visibility === "project" ? (
            <div className="space-y-1.5">
              <label htmlFor="vis-project" className="text-xs font-medium text-foreground">Project</label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="vis-project" className="w-full"><SelectValue placeholder="Choose a project" /></SelectTrigger>
                <SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>Cancel</Button>
          <Button onClick={save} disabled={update.isPending || missingTarget}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
