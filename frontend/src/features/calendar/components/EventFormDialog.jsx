"use client";

import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuthStore } from "@/store/useAuthStore";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import AttendeePicker from "@/features/calendar/components/AttendeePicker";
import RecurrenceFields from "@/features/calendar/components/RecurrenceFields";
import ReminderFields from "@/features/calendar/components/ReminderFields";
import { DEFAULT_TIME_ZONE, EVENT_TYPE_OPTIONS } from "@/features/calendar/constants/calendarOptions";
import { eventFormSchema } from "@/features/calendar/schemas/eventSchema";
import { allTimeZones, zoneLabel } from "@/features/calendar/utils/dates";

const ADMIN_ROLES = ["org-admin", "admin"];
const TEAM_CREATORS = ["org-admin", "admin", "hr", "manager"];
const ORG_CREATORS = ["org-admin", "admin", "hr"];

const toMs = (date, time) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = (time || "00:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi);
};
const fromMs = (ms) => {
  const d = new Date(ms);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
};

function Field({ label, htmlFor, error, children, className }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-foreground">{label}</label>
      {children}
      {error ? <p role="alert" className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Create / edit an event. Editing a single occurrence only exposes what an occurrence can override
 * (title, text, times); the rest belongs to the whole series. Times are entered in the chosen timezone
 * and sent as wall-clock strings — the server converts them to UTC.
 */
export default function EventFormDialog({ open, onOpenChange, mode, scope = "series", initial, isPending, onSubmit }) {
  const role = useAuthStore((state) => state.role);
  const userId = useAuthStore((state) => state.user?.id);
  const form = useForm({ defaultValues: initial, resolver: zodResolver(eventFormSchema) });
  const { register, control, watch, setValue, formState: { errors } } = form;
  const occurrenceOnly = mode === "edit" && scope === "occurrence";
  const editing = mode === "edit";

  const { data: teamsData } = useTeams({ limit: 100 });
  const { data: projectsData } = useProjects({ limit: 100 });
  const teams = useMemo(() => {
    const all = teamsData?.teams ?? [];
    if (ORG_CREATORS.includes(role)) return all;
    return all.filter((team) => team.lead?.id === userId); // managers: only teams they actually lead
  }, [teamsData, role, userId]);
  const projects = useMemo(
    () => (projectsData?.projects ?? []).filter((project) => ADMIN_ROLES.includes(role) || ["Owner", "Manager"].includes(project.myRole)),
    [projectsData, role],
  );

  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, initial, form]);

  const values = watch();
  const typeOptions = EVENT_TYPE_OPTIONS.filter((option) => {
    if (option.value === "team") return TEAM_CREATORS.includes(role) && (teams.length > 0 || editing);
    if (option.value === "organization") return ORG_CREATORS.includes(role);
    return true;
  });
  const zones = useMemo(() => [...new Set([values.timezone, DEFAULT_TIME_ZONE, "UTC", ...allTimeZones()])].filter(Boolean), [values.timezone]);

  // Keep the event's length when its start moves; never leave the end before the start.
  const moveStart = (nextDate, nextTime) => {
    const duration = Math.max(toMs(values.endDate, values.endTime) - toMs(values.startDate, values.startTime), 15 * 60000);
    const end = fromMs(toMs(nextDate, nextTime) + (values.allDay ? 0 : duration));
    if (values.allDay) {
      if (values.endDate < nextDate) setValue("endDate", nextDate);
    } else {
      setValue("endDate", end.date);
      setValue("endTime", end.time);
    }
  };

  const submit = async (data) => {
    try {
      await onSubmit(data);
      onOpenChange(false);
    } catch {
      /* the mutation already toasted the server's message; keep the dialog open */
    }
  };

  const title = editing ? (occurrenceOnly ? "Edit this event" : "Edit event") : "New event";

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] w-[95vw] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {occurrenceOnly ? "Only this occurrence changes; the rest of the series is untouched." : "Meetings and tasks are managed in their own pages and appear here automatically."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <Field label="Title" htmlFor="ev-title" error={errors.title?.message}>
            <Input id="ev-title" autoFocus placeholder="Add a title" aria-invalid={Boolean(errors.title)} {...register("title")} />
          </Field>

          {!editing ? (
            <Field label="Type" htmlFor="ev-type">
              <Controller control={control} name="type" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="ev-type" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label} — {option.description}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </Field>
          ) : null}

          {!editing && values.type === "team" ? (
            <Field label="Team" htmlFor="ev-team" error={errors.teamId?.message}>
              <Controller control={control} name="teamId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="ev-team" className="w-full" aria-invalid={Boolean(errors.teamId)}><SelectValue placeholder="Choose a team" /></SelectTrigger>
                  <SelectContent>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </Field>
          ) : null}

          {!editing && values.type === "general" && projects.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project (optional)" htmlFor="ev-project">
                <Controller control={control} name="projectId" render={({ field }) => (
                  <Select value={field.value || "none"} onValueChange={(next) => field.onChange(next === "none" ? "" : next)}>
                    <SelectTrigger id="ev-project" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No project</SelectItem>
                      {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )} />
              </Field>
              {values.projectId ? (
                <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
                  <Controller control={control} name="projectVisible" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Visible to all project members" />} />
                  Visible to all project members
                </label>
              ) : null}
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-foreground">
            <Controller control={control} name="allDay" render={({ field }) => <Switch checked={field.value} disabled={occurrenceOnly} onCheckedChange={field.onChange} aria-label="All day" />} />
            All day
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor="ev-start-date" error={errors.startDate?.message}>
              <div className="flex gap-2">
                <Input id="ev-start-date" type="date" {...register("startDate", { onChange: (e) => moveStart(e.target.value, values.startTime) })} />
                {!values.allDay ? <Input type="time" aria-label="Start time" {...register("startTime", { onChange: (e) => moveStart(values.startDate, e.target.value) })} /> : null}
              </div>
            </Field>
            <Field label="Ends" htmlFor="ev-end-date" error={errors.endDate?.message || errors.endTime?.message}>
              <div className="flex gap-2">
                <Input id="ev-end-date" type="date" min={values.startDate} {...register("endDate")} />
                {!values.allDay ? <Input type="time" aria-label="End time" {...register("endTime")} /> : null}
              </div>
            </Field>
          </div>

          {!values.allDay ? (
            <Field label="Timezone" htmlFor="ev-tz" error={errors.timezone?.message}>
              <Controller control={control} name="timezone" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={occurrenceOnly}>
                  <SelectTrigger id="ev-tz" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {zones.map((zone) => <SelectItem key={zone} value={zone}>{zone.replace(/_/g, " ")} ({zoneLabel(zone)})</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </Field>
          ) : null}

          {!occurrenceOnly ? (
            <Controller control={control} name="recurrence" render={({ field }) => (
              <RecurrenceFields
                value={field.value}
                onChange={field.onChange}
                startDate={values.startDate}
                errors={{ interval: errors.recurrence?.interval?.message, byWeekday: errors.recurrence?.byWeekday?.message, until: errors.recurrence?.until?.message, count: errors.recurrence?.count?.message }}
              />
            )} />
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Location" htmlFor="ev-location" error={errors.location?.message}><Input id="ev-location" placeholder="Room or address" {...register("location")} /></Field>
            <Field label="Meeting link" htmlFor="ev-url" error={errors.meetingUrl?.message}><Input id="ev-url" type="url" placeholder="https://…" aria-invalid={Boolean(errors.meetingUrl)} {...register("meetingUrl")} /></Field>
          </div>

          <Field label="Description" htmlFor="ev-desc"><Textarea id="ev-desc" rows={3} {...register("description")} /></Field>

          {!occurrenceOnly ? (
            <>
              <Controller control={control} name="attendees" render={({ field }) => <AttendeePicker value={field.value} onChange={field.onChange} excludeId={userId} />} />
              <Controller control={control} name="reminders" render={({ field }) => <ReminderFields value={field.value} onChange={field.onChange} error={errors.reminders?.message} />} />
            </>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : null}{editing ? "Save changes" : "Create event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
