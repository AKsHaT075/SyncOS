"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { LiveKitRoom } from "@livekit/components-react";
import { toast } from "sonner";
import { AlertCircle, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useMeeting } from "@/features/meetings/hooks/useMeeting";
import { useJoinToken } from "@/features/meetings/hooks/useJoinToken";
import { canManageMeetingClient } from "@/features/meetings/utils/permissions";
import MeetingRoomView from "@/features/meetings/components/MeetingRoomView";

export default function MeetingRoomPage() {
  const { projectId, meetingId } = useParams();
  const router = useRouter();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const { data: meetingData } = useMeeting(projectId, meetingId);
  const tokenMutation = useJoinToken(projectId, meetingId);
  const canManage = canManageMeetingClient(projectData?.project, authUser);

  // Mint exactly once per room visit — re-running on every render would
  // spam the join-token endpoint (which also records a join timestamp).
  useEffect(() => {
    tokenMutation.mutate();
  }, [projectId, meetingId]);

  if (tokenMutation.isPending || tokenMutation.isIdle) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="size-4 animate-spin text-violet-400" /> Connecting to the meeting...
        </div>
      </div>
    );
  }

  if (tokenMutation.isError || !tokenMutation.data) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 p-6">
        <Card className="flex max-w-sm flex-col items-center gap-3 border-white/10 bg-white/[0.04] p-8 text-center backdrop-blur-xl">
          <AlertCircle className="size-8 text-destructive" />
          <p className="text-sm font-medium text-white">Couldn't join this meeting</p>
          <p className="text-xs text-zinc-400">
            Video calling may not be configured yet, or you may not have permission to join.
          </p>
          <Button variant="outline" size="sm" onClick={() => router.push(`/dashboard/projects/${projectId}/meetings/${meetingId}`)}>
            Back to meeting details
          </Button>
        </Card>
      </div>
    );
  }

  // Without this, a failed connect() (bad token, unreachable LiveKit
  // server, browser blocking the WebSocket, etc.) fails silently — the UI
  // just hangs on "Connecting..." forever with nothing in the console.
  const handleError = (error) => {
    console.error("LiveKit connection error:", error);
    toast.error(`Couldn't connect to the meeting: ${error.message}`);
  };

  // The room always opens in its own tab now (see the Join button/instant
  // meeting handler), so leaving should close that tab outright. If this
  // tab wasn't opened via window.open() (e.g. someone pasted the URL
  // directly), the browser silently refuses to close it — window.close()
  // is a no-op in that case, so we fall back to a normal in-tab navigation.
  const handleDisconnected = () => {
    window.close();
    router.push(`/dashboard/projects/${projectId}/meetings/${meetingId}`);
  };

  return (
    <LiveKitRoom
      serverUrl={tokenMutation.data.url}
      token={tokenMutation.data.token}
      connect
      className="h-screen w-screen"
      onDisconnected={handleDisconnected}
      onError={handleError}
    >
      <MeetingRoomView
        meetingTopic={meetingData?.meeting?.topic || "Meeting"}
        meetingDescription={meetingData?.meeting?.description}
        meetingStatus={meetingData?.meeting?.status}
        meetingStartTime={meetingData?.meeting?.startTime}
        projectId={projectId}
        meetingId={meetingId}
        canManage={canManage}
        hostId={meetingData?.meeting?.host?.id}
        hostName={meetingData?.meeting?.host?.fullName}
      />
    </LiveKitRoom>
  );
}
