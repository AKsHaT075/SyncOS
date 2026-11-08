"use client";

import { Users2, Briefcase } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useTeam } from "@/features/teams/hooks/teamHooks";
import TeamRoom from "@/features/teams/components/TeamRoom";

export default function TeamDetailDialog({ teamId, open, onOpenChange }) {
  const { data: teamData } = useTeam(teamId);
  const team = teamData?.team;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-h-[85vh] gap-0 overflow-y-auto p-0 shadow-2xl sm:max-w-lg">
        <DialogHeader className="gap-3 border-b border-border/40 bg-muted/20 px-6 pt-7 pb-5">
          <div className="flex items-center gap-3">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Users2 className="size-6" />
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <DialogTitle className="truncate text-lg">{team?.name || "Team Room"}</DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5">
                {team && <Badge variant="secondary">{team.memberCount} Members</Badge>}
                {team?.lead && (
                  <Badge variant="outline" className="gap-1">
                    <Briefcase className="size-3" /> {team.lead.fullName}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <DialogDescription className={team?.description ? "" : "sr-only"}>
            {team?.description || `Details for ${team?.name || "this team"}`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-6">
          <TeamRoom teamId={teamId} onDeleted={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
