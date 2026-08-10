"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { scheduleMeetingSchema } from "@/features/meetings/schemas/meetingSchemas";
import { useScheduleMeeting } from "@/features/meetings/hooks/useScheduleMeeting";
import { getFriendlyErrorMessage } from "@/lib/error-message";
import { getProjectPeople } from "@/features/tasks/utils/projectPeople";

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in *local* time.
function toDatetimeLocalValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

// Defaults to "next half hour, one hour long" so most people can just hit
// submit instead of picking both dates from scratch every time.
function buildDefaultValues() {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (start.getMinutes() === 0) start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return {
    topic: "",
    description: "",
    startTime: toDatetimeLocalValue(start),
    endTime: toDatetimeLocalValue(end),
  };
}

export default function ScheduleMeetingDialog({ projectId, project, isOpen, onClose }) {
  const router = useRouter();
  const people = getProjectPeople(project);

  const mutation = useScheduleMeeting(projectId);
  const form = useForm({
    // react-hook-form only accepts `defaultValues` as a plain object or an
    // *async* function (it awaits the return value) — a plain sync function
    // makes it try to call `.then()` on the object and throw.
    defaultValues: buildDefaultValues(),
    resolver: zodResolver(scheduleMeetingSchema),
    mode: "onTouched",
  });

  const handleClose = () => {
    form.reset(buildDefaultValues());
    mutation.reset();
    onClose();
  };

  const onSubmit = async (values) => {
    mutation.reset();

    const payload = {
      topic: values.topic,
      description: values.description || undefined,
      startTime: new Date(values.startTime).toISOString(),
      endTime: new Date(values.endTime).toISOString(),
    };

    try {
      const result = await mutation.mutateAsync(payload);
      form.reset(buildDefaultValues());
      onClose();
      router.push(`/dashboard/projects/${projectId}/meetings/${result.meeting.id}`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;
  const { errors } = form.formState;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] gap-0 border-border/50 p-0 shadow-2xl sm:max-w-lg">
        <DialogHeader className="space-y-1.5 border-b border-border/40 px-6 pt-7 pb-5">
          <DialogTitle className="text-xl font-semibold tracking-tight">Schedule a meeting</DialogTitle>
          <DialogDescription>Every member of this project is automatically invited and can join.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4 px-6 py-6" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dialog-topic">
              Topic <span className="text-destructive">*</span>
            </label>
            <Input id="dialog-topic" placeholder="e.g. Sprint planning" {...form.register("topic")} />
            {errors.topic ? <p className="text-sm text-destructive">{errors.topic.message}</p> : null}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dialog-description">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea id="dialog-description" placeholder="What's this meeting about?" {...form.register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="dialog-startTime">
                Start <span className="text-destructive">*</span>
              </label>
              <Input id="dialog-startTime" type="datetime-local" {...form.register("startTime")} />
              {errors.startTime ? <p className="text-sm text-destructive">{errors.startTime.message}</p> : null}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="dialog-endTime">
                End <span className="text-destructive">*</span>
              </label>
              <Input id="dialog-endTime" type="datetime-local" {...form.register("endTime")} />
              {errors.endTime ? <p className="text-sm text-destructive">{errors.endTime.message}</p> : null}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Participants</label>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                All {people.length} project member{people.length === 1 ? "" : "s"} will be invited automatically — you can remove
                or add people individually from the meeting page afterward.
              </p>
              <p className="mt-2 truncate text-xs text-foreground">{people.map((person) => person.fullName).join(", ")}</p>
            </div>
          </div>

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage}</p>
          ) : null}

          <div className="-mx-6 -mb-6 flex justify-end gap-2 border-t border-border/40 bg-muted/30 px-6 py-5">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} className="bg-brand hover:bg-brand/90">
              {mutation.isPending ? "Scheduling..." : "Schedule Meeting"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
