"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Video } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInstantMeeting } from "@/features/meetings/hooks/useInstantMeeting";

// Two steps: (1) name the meeting, (2) it's live — share the link or join.
// The invite link points at the meeting's *detail* page, not the raw call
// URL — every project member is auto-invited already (see meeting.service.js
// createMeeting), so what's actually useful to share is a page that shows
// meeting info and lets the recipient join themselves, not a bare call link
// that still needs their own per-user token minted behind it.
export default function InstantMeetingDialog({ projectId, isOpen, onClose }) {
  const [topic, setTopic] = useState("");
  const [createdMeeting, setCreatedMeeting] = useState(null);
  const [copied, setCopied] = useState(false);
  const mutation = useInstantMeeting(projectId);

  const reset = () => {
    setTopic("");
    setCreatedMeeting(null);
    setCopied(false);
    mutation.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleStart = async (event) => {
    event.preventDefault();
    if (!topic.trim()) return;

    try {
      const result = await mutation.mutateAsync({ topic: topic.trim() });
      setCreatedMeeting(result.meeting);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const inviteUrl =
    createdMeeting && typeof window !== "undefined"
      ? `${window.location.origin}/dashboard/projects/${projectId}/meetings/${createdMeeting.id}`
      : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Couldn't copy the link — copy it manually instead.");
    }
  };

  const handleJoin = () => {
    window.open(`/meeting-room/${projectId}/${createdMeeting.id}`, "_blank", "noopener,noreferrer");
    handleClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] gap-0 border-border/50 p-0 shadow-2xl sm:max-w-md">
        {!createdMeeting ? (
          <>
            <DialogHeader className="space-y-1 border-b border-border/40 px-6 pt-7 pb-5">
              <DialogTitle className="text-xl font-semibold tracking-tight">Start an instant meeting</DialogTitle>
              <DialogDescription >Every project member is invited automatically — the room opens right away.</DialogDescription>
            </DialogHeader>

            <form className="space-y-4 px-6 py-6" onSubmit={handleStart}>
              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium" htmlFor="instant-topic">
                  Meeting name
                </label>
                <Input
                  id="instant-topic"
                  autoFocus
                  placeholder="e.g. Quick sync"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                />
              </div>

              <div className="-mx-6 -mb-6 flex justify-end gap-2 border-t border-border/40 bg-muted/30 px-6 py-5">
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!topic.trim() || mutation.isPending} className="bg-brand hover:bg-brand/90">
                  {mutation.isPending ? "Starting..." : "Start Meeting"}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogHeader className="space-y-1.5 border-b border-border/40 px-6 pt-7 pb-5">
              <DialogTitle className="text-xl font-semibold tracking-tight">{createdMeeting.topic} is live</DialogTitle>
              <DialogDescription>Share the link below, or jump straight in.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-6 py-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Invite link</label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={inviteUrl} onFocus={(event) => event.target.select()} className="text-xs" />
                  <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={handleCopy} title="Copy invite link">
                    {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Anyone on this project can open this link and join — you don't need to invite them separately.
                </p>
              </div>
            </div>

            <div className="-mt-2 flex justify-end gap-2 border-t border-border/40 bg-muted/30 px-6 py-5">
              <Button type="button" variant="outline" onClick={handleClose}>
                Done
              </Button>
              <Button type="button" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" onClick={handleJoin}>
                <Video className="size-4" /> Join Now
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
