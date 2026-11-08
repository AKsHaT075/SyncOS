"use client";

import { useRouter } from "next/navigation";
import { Users2, Briefcase, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMyTeam } from "@/features/teams/hooks/teamHooks";
import TeamRoom from "@/features/teams/components/TeamRoom";

export default function MyTeamPage() {
  const router = useRouter();
  const { data: myTeamData, isLoading } = useMyTeam();
  const myTeam = myTeamData?.team;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/95 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-8 animate-spin text-brand" />
          </div>
        ) : myTeam ? (
          <>
            <div className="flex items-center gap-3">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                <Users2 className="size-6" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <h1 className="truncate text-xl font-bold tracking-tight text-foreground">{myTeam.name}</h1>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{myTeam.memberCount} Members</Badge>
                  {myTeam.lead && (
                    <Badge variant="outline" className="gap-1">
                      <Briefcase className="size-3" /> {myTeam.lead.fullName}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            {myTeam.description && <p className="text-sm text-muted-foreground">{myTeam.description}</p>}

            <TeamRoom teamId={myTeam.id} onDeleted={() => router.push("/dashboard/teams")} />
          </>
        ) : (
          <Card className="border border-dashed border-border bg-muted/20 p-8 flex flex-col items-center justify-center text-center space-y-2">
            <Users2 className="size-8 text-muted-foreground/60" />
            <h3 className="font-semibold text-foreground text-sm">Not assigned to a team</h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              You are not currently listed in any primary team roster. Speak with your administrator or manager to
              get assigned.
            </p>
            <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/teams")} className="mt-2">
              Browse Teams
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
