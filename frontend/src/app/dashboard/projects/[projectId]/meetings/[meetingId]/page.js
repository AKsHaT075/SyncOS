"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, Clock, History, LogIn, Pencil, UserPlus, UserX, Video, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useMeeting } from "@/features/meetings/hooks/useMeeting";
import { useCancelMeeting } from "@/features/meetings/hooks/useCancelMeeting";
import { useEndMeeting } from "@/features/meetings/hooks/useEndMeeting";
import { useAddParticipants } from "@/features/meetings/hooks/useAddParticipants";
import { useRemoveParticipant } from "@/features/meetings/hooks/useRemoveParticipant";
import { useUpdateMeeting } from "@/features/meetings/hooks/useUpdateMeeting";
import { useMeetingActivity } from "@/features/meetings/hooks/useMeetingActivity";
import { updateMeetingSchema } from "@/features/meetings/schemas/meetingSchemas";
import { canManageMeetingClient } from "@/features/meetings/utils/permissions";
import { MEETING_STATUS_STYLES, MEETING_ACTION_LABELS } from "@/features/meetings/constants/meetingOptions";
import { getProjectPeople } from "@/features/tasks/utils/projectPeople";

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatRelative(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(value).toLocaleDateString();
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in *local* time —
// toISOString() gives UTC, so this trims/adjusts rather than reusing it.
function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export default function MeetingDetailPage() {
  const { projectId, meetingId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;

  const { data, isLoading, isError } = useMeeting(projectId, meetingId);
  const cancelMutation = useCancelMeeting(projectId, meetingId);
  const endMutation = useEndMeeting(projectId, meetingId);
  const addParticipantsMutation = useAddParticipants(projectId, meetingId);
  const removeParticipantMutation = useRemoveParticipant(projectId, meetingId);
  const updateMutation = useUpdateMeeting(projectId, meetingId);

  const [isEditing, setIsEditing] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  const form = useForm({ resolver: zodResolver(updateMeetingSchema) });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data?.meeting) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-8 text-center text-sm text-muted-foreground">Couldn't load this meeting.</Card>
      </div>
    );
  }

  const meeting = data.meeting;
  const canManage = canManageMeetingClient(project, authUser);
  const isParticipant = meeting.participants.some((entry) => entry.user?.id === authUser?.id);
  const canJoin = (meeting.status === "Scheduled" || meeting.status === "Active") && (canManage || isParticipant);
  const canEdit = canManage && (meeting.status === "Scheduled" || meeting.status === "Active");
  const people = getProjectPeople(project).filter(
    (person) => !meeting.participants.some((entry) => entry.user?.id === person.id)
  );

  const handleCancel = () => {
    if (window.confirm("Cancel this meeting? Invited participants keep their invite record but the meeting won't happen.")) {
      cancelMutation.mutate();
    }
  };

  const handleEnd = () => {
    if (window.confirm("End this meeting for everyone? Everyone currently in the room will be disconnected.")) {
      endMutation.mutate();
    }
  };

  const handleAddParticipants = () => {
    if (people.length === 0) {
      window.alert("Every project member is already invited to this meeting.");
      return;
    }
    const picked = window.prompt(
      `Add participants — enter comma-separated names from:\n${people.map((p) => p.fullName).join(", ")}`
    );
    if (!picked) return;
    const ids = people.filter((p) => picked.toLowerCase().includes(p.fullName.toLowerCase())).map((p) => p.id);
    if (ids.length === 0) {
      window.alert("No matching project members found.");
      return;
    }
    addParticipantsMutation.mutate(ids);
  };

  const handleRemoveParticipant = (entry) => {
    if (window.confirm(`Remove ${entry.user?.fullName} from this meeting?`)) {
      removeParticipantMutation.mutate(entry.user.id);
    }
  };

  const startEditing = () => {
    form.reset({
      topic: meeting.topic,
      description: meeting.description || "",
      startTime: toDatetimeLocalValue(meeting.startTime),
      endTime: toDatetimeLocalValue(meeting.endTime) || toDatetimeLocalValue(meeting.startTime),
    });
    setIsEditing(true);
  };

  const onSaveEdit = async (values) => {
    try {
      await updateMutation.mutateAsync({
        topic: values.topic,
        description: values.description || undefined,
        startTime: new Date(values.startTime).toISOString(),
        endTime: new Date(values.endTime).toISOString(),
      });
      setIsEditing(false);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 items-start gap-4 p-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        {isEditing ? (
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="topic">
                Topic
              </label>
              <Input id="topic" {...form.register("topic")} />
              {form.formState.errors.topic ? (
                <p className="text-sm text-destructive">{form.formState.errors.topic.message}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="description">
                Description
              </label>
              <Textarea id="description" {...form.register("description")} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="startTime">
                  Start
                </label>
                <Input id="startTime" type="datetime-local" {...form.register("startTime")} />
                {form.formState.errors.startTime ? (
                  <p className="text-sm text-destructive">{form.formState.errors.startTime.message}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="endTime">
                  End
                </label>
                <Input id="endTime" type="datetime-local" {...form.register("endTime")} />
                {form.formState.errors.endTime ? (
                  <p className="text-sm text-destructive">{form.formState.errors.endTime.message}</p>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={updateMutation.isPending} onClick={form.handleSubmit(onSaveEdit)}>
                {updateMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xl">{meeting.topic}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge className={`${MEETING_STATUS_STYLES[meeting.status]} rounded-full px-2.5 py-0.5 font-medium`} variant="outline">
                    {meeting.status}
                  </Badge>
                  {canEdit ? (
                    <Button variant="ghost" size="icon-sm" onClick={startEditing} title="Edit meeting">
                      <Pencil className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <CardDescription>
                {meeting.type} meeting hosted by {meeting.host?.fullName} · {formatDateTime(meeting.startTime)}
                {meeting.endTime ? ` – ${formatDateTime(meeting.endTime)}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {meeting.description ? <p className="text-sm text-muted-foreground">{meeting.description}</p> : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-foreground">Participants ({meeting.participants.length})</h4>
                  {canManage ? (
                    <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleAddParticipants}>
                      <UserPlus className="size-3.5" /> Add
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  {meeting.participants.map((entry) => {
                    const isHost = entry.user?.id === meeting.host?.id;
                    return (
                      <div key={entry.user?.id} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                        <div className="flex items-center gap-2.5">
                          <Avatar size="sm">
                            <AvatarFallback className="bg-muted text-[11px] font-semibold text-muted-foreground">
                              {initials(entry.user?.fullName)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-medium text-foreground">{entry.user?.fullName}</p>
                            <p className="text-xs text-muted-foreground">{entry.role}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="rounded-full text-xs">
                            {entry.status}
                          </Badge>
                          {canManage && !isHost ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => handleRemoveParticipant(entry)}
                              title="Remove participant"
                            >
                              <UserX className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
                {canManage && meeting.status === "Scheduled" ? (
                  <Button variant="outline" size="sm" className="gap-1.5 text-destructive" onClick={handleCancel}>
                    <XCircle className="size-4" /> Cancel Meeting
                  </Button>
                ) : null}
                {canManage && meeting.status === "Active" ? (
                  <Button variant="outline" size="sm" className="gap-1.5 text-destructive" onClick={handleEnd}>
                    <XCircle className="size-4" /> End for Everyone
                  </Button>
                ) : null}
                {canJoin ? (
                  // Opens in a new tab, deliberately — the call then lives in its
                  // own tab/JS context, completely isolated from whatever you do
                  // in this tab. Close that tab to leave; nothing here can touch
                  // the call's connection.
                  <Button asChild size="sm" className="gap-1.5 bg-brand hover:bg-brand/90">
                    <a href={`/meeting-room/${projectId}/${meeting.id}`} target="_blank" rel="noopener noreferrer">
                      {meeting.status === "Active" ? <Video className="size-4" /> : <LogIn className="size-4" />} Join
                    </a>
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </>
        )}
      </Card>

      <Card>
        <button
          type="button"
          onClick={() => setShowActivity((v) => !v)}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <History className="size-4 text-muted-foreground" /> Activity
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${showActivity ? "rotate-180" : ""}`} />
        </button>
        {showActivity ? <MeetingActivityList projectId={projectId} meetingId={meetingId} /> : null}
      </Card>
    </div>
  );
}

function MeetingActivityList({ projectId, meetingId }) {
  const { data, isLoading } = useMeetingActivity(projectId, meetingId, { limit: 20 });
  const activity = data?.activity || [];

  if (isLoading) {
    return (
      <div className="space-y-2 border-t border-border p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (activity.length === 0) {
    return <p className="border-t border-border p-4 text-sm text-muted-foreground">No activity recorded yet.</p>;
  }

  return (
    <ul className="space-y-1 border-t border-border p-2">
      {activity.map((log) => (
        <li key={log._id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm">
          <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-foreground">
              <span className="font-medium">
                {log.user ? `${log.user.firstName} ${log.user.lastName}`.trim() : "Someone"}
              </span>{" "}
              <span className="text-muted-foreground">{MEETING_ACTION_LABELS[log.action] || log.action}</span>
            </p>
            <p className="text-xs text-muted-foreground">{formatRelative(log.createdAt)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
