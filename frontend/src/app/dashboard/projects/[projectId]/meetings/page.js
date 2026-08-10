"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, CalendarClock, ChevronDown, ClipboardList, History, Plus, Users, Video, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useMeetings } from "@/features/meetings/hooks/useMeetings";
import { canRequestMeetingClient, canScheduleMeetingClient } from "@/features/meetings/utils/permissions";
import { MEETING_STATUS_STYLES, MEETING_STATUSES } from "@/features/meetings/constants/meetingOptions";
import ScheduleMeetingDialog from "@/features/meetings/components/ScheduleMeetingDialog";
import InstantMeetingDialog from "@/features/meetings/components/InstantMeetingDialog";

const ALL = "all";
const PAST_STATUSES = new Set(["Ended", "Cancelled"]);

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatRelative(value) {
  const diffMs = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const label = mins < 60 ? `${mins}m` : Math.round(mins / 60) < 24 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 60 / 24)}d`;
  if (mins <= 1 && diffMs > -60000) return "starting now";
  return diffMs > 0 ? `in ${label}` : `${label} ago`;
}

function canJoinMeetingClient(meeting, canManage, authUser) {
  if (meeting.status !== "Active") return false;
  if (canManage) return true;
  return meeting.participants.some((entry) => entry.user?.id === authUser?.id);
}

// Sensible sort per tier: what's coming up soonest first, what already
// happened most-recently-first — chronological-ascending-always (the raw
// API default) is exactly backwards for a page people check daily, since it
// buries this week's meetings under months of old "Quick sync"s.
function byStartTimeAsc(a, b) {
  return new Date(a.startTime) - new Date(b.startTime);
}
function byStartTimeDesc(a, b) {
  return new Date(b.startTime) - new Date(a.startTime);
}

export default function ProjectMeetingsPage() {
  const { projectId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;

  const [status, setStatus] = useState(ALL);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [instantOpen, setInstantOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);

  const { data, isLoading, isError } = useMeetings(projectId, {
    ...(status !== ALL && { status, sortOrder: PAST_STATUSES.has(status) ? "desc" : "asc" }),
  });

  const allMeetings = data?.meetings ?? [];
  const canSchedule = canScheduleMeetingClient(project, authUser);
  const canRequest = canRequestMeetingClient(project, authUser);

  const { liveMeetings, upcomingMeetings, pastMeetings } = useMemo(() => {
    if (status !== ALL) {
      // A specific filter tab is just that one bucket, already sorted by
      // the API call above — no tiering needed.
      return { liveMeetings: [], upcomingMeetings: [], pastMeetings: [] };
    }
    return {
      liveMeetings: allMeetings.filter((m) => m.status === "Active"),
      upcomingMeetings: allMeetings.filter((m) => m.status === "Scheduled").sort(byStartTimeAsc),
      pastMeetings: allMeetings.filter((m) => PAST_STATUSES.has(m.status)).sort(byStartTimeDesc),
    };
  }, [allMeetings, status]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={status === ALL ? "secondary" : "ghost"} size="sm" className="rounded-full" onClick={() => setStatus(ALL)}>
            All
          </Button>
          {MEETING_STATUSES.map((value) => (
            <Button
              key={value}
              variant={status === value ? "secondary" : "ghost"}
              size="sm"
              className="rounded-full"
              onClick={() => setStatus(value)}
            >
              {value}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canSchedule ? (
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href={`/dashboard/projects/${projectId}/meetings/requests`}>
                <ClipboardList className="size-4" /> Requests
              </Link>
            </Button>
          ) : null}
          {canRequest ? (
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href={`/dashboard/projects/${projectId}/meetings/requests/new`}>
                <ClipboardList className="size-4" /> Request a Meeting
              </Link>
            </Button>
          ) : null}
          {canSchedule ? (
            <>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setInstantOpen(true)}>
                <Zap className="size-4" /> Start Instant Meeting
              </Button>
              <Button size="sm" className="gap-2 bg-brand hover:bg-brand/90" onClick={() => setScheduleOpen(true)}>
                <Plus className="size-4" /> Schedule
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard icon={AlertCircle} title="Couldn't load meetings" description="Please try again in a moment." />
        </Card>
      ) : allMeetings.length === 0 ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard
            icon={Video}
            title="No meetings yet"
            description={canSchedule ? "Schedule or start an instant meeting to get going." : "Ask a manager to schedule a meeting, or request one."}
          />
        </Card>
      ) : status !== ALL ? (
        <div className="flex flex-col gap-4">
          {allMeetings.map((meeting) => (
            <MeetingCard key={meeting.id} projectId={projectId} meeting={meeting} canSchedule={canSchedule} authUser={authUser} />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {liveMeetings.length > 0 ? (
            <Section
              label="Live Now"
              labelClassName="text-emerald-700"
              icon={
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
              }
            >
              {liveMeetings.map((meeting) => (
                <MeetingCard key={meeting.id} projectId={projectId} meeting={meeting} canSchedule={canSchedule} authUser={authUser} />
              ))}
            </Section>
          ) : null}

          {upcomingMeetings.length > 0 ? (
            <Section label="Upcoming" labelClassName="text-brand" icon={<CalendarClock className="size-3.5 text-brand" />}>
              {upcomingMeetings.map((meeting) => (
                <MeetingCard key={meeting.id} projectId={projectId} meeting={meeting} canSchedule={canSchedule} authUser={authUser} />
              ))}
            </Section>
          ) : null}

          {pastMeetings.length > 0 ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setPastOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 rounded-lg px-0.5 py-1 text-left"
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <History className="size-3.5" /> Past Meetings ({pastMeetings.length})
                </span>
                <ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${pastOpen ? "rotate-180" : ""}`} />
              </button>
              {pastOpen ? (
                <div className="flex flex-col gap-3">
                  {pastMeetings.map((meeting) => (
                    <MeetingCard
                      key={meeting.id}
                      projectId={projectId}
                      meeting={meeting}
                      canSchedule={canSchedule}
                      authUser={authUser}
                      muted
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <ScheduleMeetingDialog
        projectId={projectId}
        project={project}
        isOpen={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
      />
      <InstantMeetingDialog projectId={projectId} isOpen={instantOpen} onClose={() => setInstantOpen(false)} />
    </div>
  );
}

function Section({ label, labelClassName, icon, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 px-0.5">
        {icon}
        <h3 className={`text-xs font-semibold tracking-wide uppercase ${labelClassName}`}>{label}</h3>
      </div>
      {/* flex+gap, not space-y — cards are wrapped in <Link> (inline by
          default), and CSS ignores top/bottom margin on inline elements, so
          space-y's margin-based spacing silently collapses to zero here. */}
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

function MeetingCard({ projectId, meeting, canSchedule, authUser, muted = false }) {
  const isActive = meeting.status === "Active";
  const isUpcoming = meeting.status === "Scheduled";
  const canJoin = canJoinMeetingClient(meeting, canSchedule, authUser);

  return (
    <Card
      className={`flex flex-col gap-3 p-4 shadow-sm transition-all duration-200 sm:flex-row sm:items-center sm:justify-between ${
        isActive
          ? "border-emerald-200"
          : isUpcoming
            ? "border-brand/20 hover:border-brand/40 hover:shadow-md hover:-translate-y-0.5"
            : muted
              ? "border-border/60 opacity-80 hover:opacity-100"
              : "hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"
      }`}
    >
      <Link href={`/dashboard/projects/${projectId}/meetings/${meeting.id}`} className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate font-semibold text-foreground">{meeting.topic}</h4>
          <Badge
            className={`${
              isActive ? "bg-emerald-100 text-emerald-700" : MEETING_STATUS_STYLES[meeting.status]
            } rounded-full px-2.5 py-0.5 font-medium`}
            variant="outline"
          >
            {meeting.status}
          </Badge>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" /> {meeting.host?.fullName} · {meeting.participants.length} participant
          {meeting.participants.length === 1 ? "" : "s"}
        </p>
      </Link>

      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right">
          <p className="text-sm text-muted-foreground">{formatDateTime(meeting.startTime)}</p>
          {isUpcoming ? <p className="text-xs font-medium text-brand">{formatRelative(meeting.startTime)}</p> : null}
        </div>
        {canJoin ? (
          <Button asChild size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
            <a href={`/meeting-room/${projectId}/${meeting.id}`} target="_blank" rel="noopener noreferrer">
              <Video className="size-4" /> Join Now
            </a>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
