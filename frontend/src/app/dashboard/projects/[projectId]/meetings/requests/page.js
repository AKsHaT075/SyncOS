"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, ArrowLeft, Check, ClipboardList, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useMeetingRequests } from "@/features/meetingRequests/hooks/useMeetingRequests";
import {
  useApproveMeetingRequest,
  useRejectMeetingRequest,
  useScheduleMeetingRequest,
} from "@/features/meetingRequests/hooks/useDecideMeetingRequest";
import { canScheduleMeetingClient } from "@/features/meetings/utils/permissions";
import { MEETING_REQUEST_STATUS_STYLES } from "@/features/meetings/constants/meetingOptions";

function formatDate(value) {
  if (!value) return "No preference";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function MeetingRequestsPage() {
  const { projectId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;

  const { data, isLoading, isError } = useMeetingRequests(projectId);
  const approveMutation = useApproveMeetingRequest(projectId);
  const rejectMutation = useRejectMeetingRequest(projectId);
  const scheduleMutation = useScheduleMeetingRequest(projectId);

  const requests = data?.requests ?? [];
  const canDecide = canScheduleMeetingClient(project, authUser);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Link
        href={`/dashboard/projects/${projectId}/meetings`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back to meetings
      </Link>

      <h2 className="text-lg font-semibold text-foreground">Meeting Requests</h2>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard icon={AlertCircle} title="Couldn't load requests" description="Please try again in a moment." />
        </Card>
      ) : requests.length === 0 ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard icon={ClipboardList} title="No meeting requests" description="Requests submitted by the team will show up here." />
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              projectId={projectId}
              request={request}
              canDecide={canDecide}
              onApprove={() => approveMutation.mutate({ requestId: request.id, payload: {} })}
              onReject={() => {
                const remarks = window.prompt("Reason for rejecting (optional):") || "";
                rejectMutation.mutate({ requestId: request.id, payload: { remarks } });
              }}
              onSchedule={(startTime, endTime) =>
                scheduleMutation.mutate({ requestId: request.id, payload: { startTime, endTime } })
              }
              busy={approveMutation.isPending || rejectMutation.isPending || scheduleMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({ projectId, request, canDecide, onApprove, onReject, onSchedule, busy }) {
  const [scheduling, setScheduling] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const isPending = request.status === "Pending";

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h4 className="font-semibold text-foreground">{request.topic}</h4>
          <p className="text-sm text-muted-foreground">{request.reason}</p>
        </div>
        <Badge className={`${MEETING_REQUEST_STATUS_STYLES[request.status]} rounded-full px-2.5 py-0.5 font-medium`} variant="outline">
          {request.status}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Requested by {request.requestedBy?.fullName} · Preferred: {formatDate(request.preferredDate)}
        {request.preferredTime ? ` at ${request.preferredTime}` : ""}
        {request.requestedMembers.length > 0 ? ` · With ${request.requestedMembers.map((m) => m.fullName).join(", ")}` : ""}
      </p>

      {request.decisionRemarks ? <p className="text-xs text-muted-foreground italic">"{request.decisionRemarks}"</p> : null}

      {request.resultingMeeting ? (
        <Link
          href={`/dashboard/projects/${projectId}/meetings/${request.resultingMeeting}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
        >
          <ExternalLink className="size-3.5" /> View the meeting
        </Link>
      ) : null}

      {canDecide && isPending ? (
        <div className="space-y-2 border-t border-border pt-3">
          {scheduling ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Start</label>
                <Input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-48" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">End</label>
                <Input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-48" />
              </div>
              <Button
                size="sm"
                disabled={!startTime || !endTime || busy}
                onClick={() => onSchedule(new Date(startTime).toISOString(), new Date(endTime).toISOString())}
              >
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setScheduling(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="gap-1.5" disabled={busy} onClick={onApprove}>
                <Check className="size-3.5" /> Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setScheduling(true)} disabled={busy}>
                Schedule for a specific time
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-destructive" disabled={busy} onClick={onReject}>
                <X className="size-3.5" /> Reject
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
