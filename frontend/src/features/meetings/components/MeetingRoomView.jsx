"use client";

import { useEffect, useState } from "react";
import { Track, ConnectionQuality, ConnectionState } from "livekit-client";
import {
  RoomAudioRenderer,
  VideoTrack,
  isTrackReference,
  useConnectionState,
  useIsSpeaking,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import {
  Check,
  ChevronUp,
  Clock,
  Crown,
  Hand,
  History,
  Info,
  Link2,
  Loader2,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  MoreVertical,
  PhoneOff,
  Settings,
  UserMinus,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKickParticipant } from "@/features/meetings/hooks/useKickParticipant";
import { useMeetingActivity } from "@/features/meetings/hooks/useMeetingActivity";
import { MEETING_ACTION_LABELS, MEETING_STATUS_STYLES } from "@/features/meetings/constants/meetingOptions";

// Solid, saturated fills — legible white-on-color for the placeholder avatar
// circle shown when a tile has no camera track (Meet's own convention).
const AVATAR_PALETTE = [
  "bg-violet-600",
  "bg-blue-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-fuchsia-600",
  "bg-indigo-600",
];

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Deterministic per-participant color so the same person keeps the same
// avatar color across renders/reconnects, without persisting anything.
function avatarStyle(seed) {
  const value = (seed || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_PALETTE[value % AVATAR_PALETTE.length];
}

function isHandRaised(participant) {
  return participant.attributes?.handRaised === "true";
}

function formatRelative(value) {
  if (!value) return "";
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(value).toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(totalSeconds) {
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// Counts up from the moment the LiveKit connection reaches Connected —
// meeting.startTime can be well before anyone actually joined, so it isn't
// a useful "how long has this call been going" clock.
function useCallDuration(connectionState) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    const startedAt = Date.now();
    const interval = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [connectionState]);
  return seconds;
}

// Toggles the browser's native fullscreen on the whole page — the room is
// already chromeless (no Sidebar/Topbar), so fullscreen just drops the
// browser's own UI too, matching Meet's fullscreen button.
function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };
  return [isFullscreen, toggle];
}

// A simple square-ish column count — Meet's own layout engine does a lot
// more (active-speaker pinning, pagination past ~50 tiles), but project
// meetings here are small groups, so this covers the real range without
// pulling in a second layout system.
function gridColumns(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function ConnectionDot({ quality }) {
  const color =
    quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good
      ? "bg-emerald-400"
      : quality === ConnectionQuality.Poor
        ? "bg-amber-400"
        : quality === ConnectionQuality.Lost
          ? "bg-red-400"
          : "bg-zinc-500";
  return <span className={`size-1.5 shrink-0 rounded-full ${color}`} title={`Connection: ${quality}`} />;
}

function VideoTile({ trackRef, isHost }) {
  const participant = trackRef.participant;
  const isSpeaking = useIsSpeaking(participant);
  const hasVideo = isTrackReference(trackRef) && !trackRef.publication.isMuted;
  const name = participant.name || participant.identity;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10",
        isSpeaking && "ring-2 ring-violet-400"
      )}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className="h-full w-full object-cover"
          style={participant.isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <div
            className={`flex size-16 items-center justify-center rounded-full text-xl font-semibold text-white sm:size-20 sm:text-2xl ${avatarStyle(participant.identity)}`}
          >
            {initials(name)}
          </div>
        </div>
      )}

      <div className="absolute top-2 right-2 flex items-center gap-1.5">
        {isHandRaised(participant) ? (
          <span className="flex size-6 items-center justify-center rounded-full bg-amber-400 text-zinc-900 shadow">
            <Hand className="size-3.5" />
          </span>
        ) : null}
        {isHost ? (
          <span className="flex size-6 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm">
            <Crown className="size-3.5 text-amber-400" strokeWidth={2.5} />
          </span>
        ) : null}
      </div>

      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-xs text-white backdrop-blur-sm">
        {participant.isMicrophoneEnabled ? null : <MicOff className="size-3 shrink-0 text-red-400" />}
        <span className="truncate">
          {name}
          {participant.isLocal ? " (You)" : ""}
        </span>
      </div>
    </div>
  );
}

function ParticipantRow({ participant, isHost, canManage, onKick }) {
  const isSelf = participant.isLocal;
  return (
    <li className="group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-white/[0.06]">
      <div className="relative shrink-0">
        <Avatar size="sm">
          <AvatarFallback className={`text-[11px] font-semibold text-white ${avatarStyle(participant.identity)}`}>
            {initials(participant.name || participant.identity)}
          </AvatarFallback>
        </Avatar>
        {isHost ? (
          <Crown className="absolute -top-1.5 -right-1.5 size-3 rounded-full bg-zinc-950 text-amber-400" strokeWidth={2.5} />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate font-medium text-zinc-100">{participant.name || participant.identity}</span>
        {isSelf ? <span className="shrink-0 text-xs text-zinc-500">(You)</span> : null}
      </div>
      {isHandRaised(participant) ? <Hand className="size-3.5 shrink-0 text-amber-400" /> : null}
      <ConnectionDot quality={participant.connectionQuality} />
      {participant.isMicrophoneEnabled ? (
        <Mic className="size-3.5 shrink-0 text-zinc-500" />
      ) : (
        <MicOff className="size-3.5 shrink-0 text-red-400" />
      )}
      {canManage && !isSelf && !isHost ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-500 opacity-0 transition-opacity hover:bg-white/10 hover:text-zinc-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              title="Participant actions"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={() => onKick(participant)}>
              <UserMinus className="size-3.5" /> Remove from call
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="size-6 shrink-0" />
      )}
    </li>
  );
}

function ActivityTab({ projectId, meetingId }) {
  const { data, isLoading } = useMeetingActivity(projectId, meetingId, { limit: 20 });
  const activity = data?.activity || [];

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-10 w-full bg-white/5" />
        <Skeleton className="h-10 w-full bg-white/5" />
        <Skeleton className="h-10 w-full bg-white/5" />
      </div>
    );
  }

  if (activity.length === 0) {
    return <p className="p-4 text-sm text-zinc-500">No activity recorded yet.</p>;
  }

  return (
    <ul className="space-y-0.5 p-2">
      {activity.map((log) => (
        <li key={log._id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm">
          <Clock className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
          <div className="min-w-0 flex-1">
            <p className="text-zinc-200">
              <span className="font-medium">{log.user ? `${log.user.firstName} ${log.user.lastName}`.trim() : "Someone"}</span>{" "}
              <span className="text-zinc-500">{MEETING_ACTION_LABELS[log.action] || log.action}</span>
            </p>
            <p className="text-xs text-zinc-600">{formatRelative(log.createdAt)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SidePanel({ projectId, meetingId, participants, hostId, canManage, onKick, mobileOpen, onCloseMobile }) {
  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close panel"
          onClick={onCloseMobile}
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm sm:hidden"
        />
      ) : null}
      <aside
        className={cn(
          "flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] shadow-xl backdrop-blur-xl",
          mobileOpen ? "fixed inset-y-4 right-4 z-30 flex w-72" : "hidden",
          "sm:static sm:z-auto sm:flex sm:w-72 sm:shrink-0"
        )}
      >
        <Tabs defaultValue="participants" className="flex h-full min-h-0 flex-col gap-0">
          <div className="flex items-center justify-between gap-2 p-2 pb-0">
            <TabsList className="bg-white/5">
              <TabsTrigger value="participants" className="gap-1.5 text-zinc-300 data-[state=active]:bg-white/10 data-[state=active]:text-white">
                <Users className="size-3.5" /> People
              </TabsTrigger>
              <TabsTrigger value="activity" className="gap-1.5 text-zinc-300 data-[state=active]:bg-white/10 data-[state=active]:text-white">
                <History className="size-3.5" /> Activity
              </TabsTrigger>
            </TabsList>
            <button
              type="button"
              onClick={onCloseMobile}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white sm:hidden"
              aria-label="Close panel"
            >
              <X className="size-4" />
            </button>
          </div>

          <TabsContent value="participants" className="min-h-0 flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              {participants.map((participant) => (
                <ParticipantRow
                  key={participant.sid}
                  participant={participant}
                  isHost={Boolean(hostId) && participant.identity === hostId}
                  canManage={canManage}
                  onKick={onKick}
                />
              ))}
            </ul>
          </TabsContent>

          <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
            <ActivityTab projectId={projectId} meetingId={meetingId} />
          </TabsContent>
        </Tabs>
      </aside>
    </>
  );
}

// Lists the input/output devices of one kind as a radio group inside
// whichever DropdownMenuContent renders it — used for both the mic/camera
// quick-switch menus and the speaker picker in "More options".
function DeviceRadioItems({ kind, room, label }) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, room });
  if (devices.length === 0) return null;

  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={activeDeviceId} onValueChange={setActiveMediaDevice}>
        {devices.map((device, index) => (
          <DropdownMenuRadioItem key={device.deviceId || index} value={device.deviceId}>
            <span className="truncate">{device.label || `${label} ${index + 1}`}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

// Meet-style split button: the wide half toggles mic/camera on and off, the
// narrow chevron half opens a device picker for that same input kind.
function MediaControlButton({ kind, room, active, onToggle, ActiveIcon, InactiveIcon, activeTitle, inactiveTitle, deviceLabel }) {
  return (
    <div className={cn("flex items-center overflow-hidden rounded-full", active ? "bg-white/10" : "bg-white")}>
      <button
        type="button"
        onClick={onToggle}
        title={active ? activeTitle : inactiveTitle}
        className={cn(
          "flex size-11 items-center justify-center transition-colors",
          active ? "text-white hover:bg-white/15" : "text-zinc-900 hover:bg-zinc-100"
        )}
      >
        {active ? <ActiveIcon className="size-5" /> : <InactiveIcon className="size-5 text-red-600" />}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={`Choose ${deviceLabel.toLowerCase()}`}
            className={cn(
              "flex h-11 w-6 items-center justify-center border-l transition-colors",
              active ? "border-white/10 text-white/70 hover:bg-white/15" : "border-black/10 text-zinc-500 hover:bg-zinc-100"
            )}
          >
            <ChevronUp className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" className="w-56">
          <DeviceRadioItems kind={kind} room={room} label={deviceLabel} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RaiseHandButton({ active, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? "Lower hand" : "Raise hand"}
      className={cn(
        "flex size-11 items-center justify-center rounded-full transition-colors",
        active ? "bg-amber-400 text-zinc-900 hover:bg-amber-300" : "bg-white/10 text-white hover:bg-white/15"
      )}
    >
      <Hand className="size-5" />
    </button>
  );
}

function MoreOptionsMenu({ room }) {
  const [isFullscreen, toggleFullscreen] = useFullscreen();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="More options"
          className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/15"
        >
          <Settings className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-56">
        <DeviceRadioItems kind="audiooutput" room={room} label="Speaker" />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
          {isFullscreen ? "Exit full screen" : "Full screen"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Bottom-left "meeting code" chip, Meet-style — copies the link to this
// meeting's detail page (the same URL the invite email sends), not the raw
// LiveKit room, since joining still goes through getJoinToken's own
// permission check either way.
function MeetingLinkChip({ path }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(`${window.location.origin}${path}`)
      .then(() => {
        setCopied(true);
        toast.success("Meeting link copied");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.error("Couldn't copy the link"));
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy meeting link"
      className="hidden items-center gap-2 rounded-full border border-white/10 bg-zinc-900/90 px-3.5 py-2.5 text-xs font-medium text-zinc-300 backdrop-blur-xl transition-colors hover:bg-zinc-800 hover:text-white sm:flex"
    >
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Link2 className="size-3.5 text-zinc-400" />}
      {copied ? "Copied" : "Meeting link"}
    </button>
  );
}

function MeetingInfoButton({ meetingTopic, meetingDescription, meetingStatus, hostName, startTime, path }) {
  const handleCopy = () => {
    navigator.clipboard
      .writeText(`${window.location.origin}${path}`)
      .then(() => toast.success("Meeting link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Meeting details"
          className="hidden size-11 items-center justify-center rounded-full border border-white/10 bg-zinc-900/90 text-zinc-300 backdrop-blur-xl transition-colors hover:bg-zinc-800 hover:text-white sm:flex"
        >
          <Info className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80">
        <div>
          <p className="font-semibold text-foreground">{meetingTopic}</p>
          {meetingDescription ? <p className="mt-1 text-sm text-muted-foreground">{meetingDescription}</p> : null}
        </div>
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium text-foreground">{meetingStatus || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Host</dt>
            <dd className="font-medium text-foreground">{hostName || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="font-medium text-foreground">{formatDateTime(startTime)}</dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-left transition-colors hover:bg-muted"
        >
          <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{path}</span>
          <span className="shrink-0 text-xs font-medium text-foreground">Copy</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

// Deliberately not the prebuilt <VideoConference/> (bundles chat/screen-share
// we're told not to build) — a hand-rolled Meet-style grid, participant
// list, and controls: raise hand, mic + device picker, camera + device
// picker, speaker/fullscreen, leave. Rendered full-screen (see
// app/meeting-room/layout.js — no Sidebar/Topbar chrome), styled with the
// same dark/violet portal theme as the rest of the app's shell (see
// components/layout/Sidebar.jsx).
export default function MeetingRoomView({
  meetingTopic,
  meetingDescription,
  meetingStatus,
  meetingStartTime,
  projectId,
  meetingId,
  canManage,
  hostId,
  hostName,
}) {
  const meetingPath = `/dashboard/projects/${projectId}/meetings/${meetingId}`;
  const room = useRoomContext();
  const participants = useParticipants();
  const connectionState = useConnectionState();
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();
  const duration = useCallDuration(connectionState);
  const kickMutation = useKickParticipant(projectId, meetingId);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);

  // `withPlaceholder: true` is what makes every participant show up as a
  // tile (with a name/avatar placeholder) even before they've turned their
  // camera on — without it, useTracks only returns tracks that actually
  // exist, so anyone who hasn't published video yet is invisible, which
  // read as "I can't see the other person" even though they were in the
  // call the whole time.
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const columns = gridColumns(tracks.length);

  // Disconnecting fires the <LiveKitRoom onDisconnected> handler (in the
  // room page), which owns what happens next — closing this tab, or
  // falling back to an in-tab navigation if it wasn't opened via
  // window.open(). Kept here as a single source of truth instead of
  // duplicating that decision in two places.
  const leave = () => {
    room.disconnect();
  };

  // setMicrophoneEnabled/setCameraEnabled reject silently on a denied OS/
  // browser permission or a missing device — without this the button just
  // looks like it did nothing, with no indication of why.
  const toggleMicrophone = () => {
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch((error) => {
      toast.error(`Couldn't access your microphone: ${error.message}`);
    });
  };

  const toggleCamera = () => {
    localParticipant.setCameraEnabled(!isCameraEnabled).catch((error) => {
      toast.error(`Couldn't access your camera: ${error.message}`);
    });
  };

  // Participant attributes sync to everyone in the room automatically
  // (LiveKit's own realtime state, no data channel plumbing needed) — every
  // tile/list row reads the same `handRaised` attribute off `useParticipants()`,
  // which re-renders on attribute changes. Local state here just makes this
  // button itself flip instantly instead of waiting on the round trip.
  const toggleHand = () => {
    const next = !handRaised;
    setHandRaised(next);
    localParticipant.setAttributes({ handRaised: next ? "true" : "" }).catch(() => {
      setHandRaised(!next);
      toast.error("Couldn't update your hand-raise status");
    });
  };

  const handleKick = (participant) => {
    if (window.confirm(`Remove ${participant.name || participant.identity} from this call? They can rejoin from the meeting page.`)) {
      kickMutation.mutate(participant.identity);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-950">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-zinc-950/60 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate font-semibold text-white">{meetingTopic}</span>
          {meetingStatus ? (
            <Badge
              className={`${MEETING_STATUS_STYLES[meetingStatus] || ""} shrink-0 gap-1.5 rounded-full border-0 px-2.5 py-0.5 font-medium`}
            >
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-current" />
              </span>
              {meetingStatus}
            </Badge>
          ) : null}
          {connectionState === ConnectionState.Connected ? (
            <span className="hidden shrink-0 items-center gap-1.5 font-mono text-xs text-zinc-400 sm:flex">
              <Clock className="size-3.5" /> {formatDuration(duration)}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setMobilePanelOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-sm text-zinc-300 hover:bg-white/10 sm:hidden"
          >
            <Users className="size-4" /> {participants.length}
          </button>
          <span className="hidden items-center gap-1.5 text-sm text-zinc-400 sm:flex">
            <Users className="size-4" /> {participants.length}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-3 sm:p-4">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl">
          {connectionState !== ConnectionState.Connected ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-zinc-950/95 text-sm text-zinc-300">
              <Loader2 className="size-5 animate-spin text-violet-400" /> Connecting...
            </div>
          ) : null}
          <div
            className="grid h-full gap-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: "1fr" }}
          >
            {tracks.map((trackRef) => (
              <VideoTile
                key={`${trackRef.participant.sid}-${trackRef.source}`}
                trackRef={trackRef}
                isHost={Boolean(hostId) && trackRef.participant.identity === hostId}
              />
            ))}
          </div>
          <RoomAudioRenderer />
        </div>

        <SidePanel
          projectId={projectId}
          meetingId={meetingId}
          participants={participants}
          hostId={hostId}
          canManage={canManage}
          onKick={handleKick}
          mobileOpen={mobilePanelOpen}
          onCloseMobile={() => setMobilePanelOpen(false)}
        />
      </div>

      <footer className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 pb-6 sm:px-6">
        <div className="flex justify-start">
          <MeetingLinkChip path={meetingPath} />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-white/10 bg-zinc-900/90 px-3 py-2.5 shadow-2xl backdrop-blur-xl">
          <RaiseHandButton active={handRaised} onToggle={toggleHand} />

          <MediaControlButton
            kind="audioinput"
            room={room}
            active={isMicrophoneEnabled}
            onToggle={toggleMicrophone}
            ActiveIcon={Mic}
            InactiveIcon={MicOff}
            activeTitle="Mute microphone"
            inactiveTitle="Unmute microphone"
            deviceLabel="Microphone"
          />

          <MediaControlButton
            kind="videoinput"
            room={room}
            active={isCameraEnabled}
            onToggle={toggleCamera}
            ActiveIcon={Video}
            InactiveIcon={VideoOff}
            activeTitle="Turn off camera"
            inactiveTitle="Turn on camera"
            deviceLabel="Camera"
          />

          <MoreOptionsMenu room={room} />

          <div className="mx-1 h-8 w-px bg-white/10" />

          <button
            type="button"
            onClick={leave}
            title="Leave meeting"
            className="flex h-11 items-center gap-2 rounded-full bg-red-600 px-5 text-white transition-colors hover:bg-red-700"
          >
            <PhoneOff className="size-5" />
          </button>
        </div>

        <div className="flex justify-end">
          <MeetingInfoButton
            meetingTopic={meetingTopic}
            meetingDescription={meetingDescription}
            meetingStatus={meetingStatus}
            hostName={hostName}
            startTime={meetingStartTime}
            path={meetingPath}
          />
        </div>
      </footer>
    </div>
  );
}
