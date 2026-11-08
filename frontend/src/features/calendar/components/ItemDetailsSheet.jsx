"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, CalendarClock, CheckSquare, ExternalLink, FolderKanban, Globe2, Loader2, MapPin, Pencil, Repeat, Trash2, Users2, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuthStore } from "@/store/useAuthStore";
import { useCalendarEvent, useRsvp } from "@/features/calendar/hooks/calendarHooks";
import { CATEGORY_BY_VALUE, describeRecurrence, reminderLabel } from "@/features/calendar/constants/calendarOptions";
import { describeWhen, zoneLabel } from "@/features/calendar/utils/dates";
import { isCancelled } from "@/features/calendar/utils/items";
import { cn } from "@/lib/utils";

function Row({ icon: Icon, children }) {
  return (
    <div className="flex items-start gap-3 text-sm text-foreground">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PeopleList({ people }) {
  if (!people?.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {people.map((person) => (
        <li key={person.id}>
          <Badge variant="outline" className="gap-1 font-normal">
            {person.name}
            {person.status && person.status !== "invited" ? <span className="text-muted-foreground">· {person.status}</span> : null}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

const SOURCE_NOTE = {
  meeting: "This meeting is managed in Meetings — open it to change anything.",
  task: "This deadline comes from a task — open the task to change it.",
  project: "This deadline comes from the project — open the project to change it.",
};

/** Details for any calendar item. Meetings, tasks and projects are read-only here and link to their own pages. */
export default function ItemDetailsSheet({ item, open, onOpenChange, timeZone, onEdit, onDelete }) {
  const role = useAuthStore((state) => state.role);
  const [pendingStatus, setPendingStatus] = useState(null);
  const isEvent = item?.source === "event";
  const detailQuery = useCalendarEvent(open && isEvent ? item.eventId : null);
  const detail = detailQuery.data?.event;
  const rsvp = useRsvp();

  if (!item) return null;
  const category = CATEGORY_BY_VALUE[item.category];
  const title = item.title;
  const sourceZone = detail?.timezone && detail.timezone !== timeZone && !item.allDay ? detail.timezone : null;

  const respond = (status) => {
    setPendingStatus(status);
    rsvp.mutate({ id: item.eventId, status }, { onSettled: () => setPendingStatus(null) });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <div className="flex items-center gap-2 pr-8">
            <span className={cn("size-2.5 rounded-full", category?.dot)} aria-hidden="true" />
            <span className="text-xs font-medium text-muted-foreground">{category?.label}</span>
            {isCancelled(item) ? <Badge variant="destructive">Cancelled</Badge> : null}
            {item.done && item.source === "task" ? <Badge variant="secondary">{item.status}</Badge> : null}
          </div>
          <SheetTitle className={cn("text-lg", (item.done || isCancelled(item)) && "line-through")}>{title}</SheetTitle>
          <SheetDescription className="sr-only">Details for this calendar item.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 p-4">
          <Row icon={CalendarClock}>
            <p className="font-medium">{describeWhen(item, timeZone)}</p>
            <p className="text-xs text-muted-foreground">{item.allDay ? "All day" : `Shown in ${timeZone.replace(/_/g, " ")} (${zoneLabel(timeZone)})`}</p>
            {sourceZone ? (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <Globe2 className="size-3" />Created in {sourceZone.replace(/_/g, " ")}
              </p>
            ) : null}
          </Row>

          {item.recurring ? (
            <Row icon={Repeat}>
              {detail?.recurrence ? describeRecurrence(detail.recurrence) : <Skeleton className="h-4 w-40" />}
              {item.modified ? <p className="text-xs text-muted-foreground">This occurrence was edited.</p> : null}
            </Row>
          ) : null}

          {item.location ? <Row icon={MapPin}>{item.location}</Row> : null}
          {item.meetingUrl ? (
            <Row icon={Video}>
              <a href={item.meetingUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                Open meeting link<ExternalLink className="size-3" />
              </a>
            </Row>
          ) : null}
          {item.description ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{item.description}</p> : null}

          {item.project ? <Row icon={FolderKanban}>{item.project.name}</Row> : null}
          {item.source === "task" ? (
            <>
              <Row icon={CheckSquare}>{item.status}{item.priority ? ` · ${item.priority} priority` : ""}</Row>
              {item.assignees?.length ? <Row icon={Users2}><PeopleList people={item.assignees} /></Row> : null}
            </>
          ) : null}
          {item.source === "meeting" ? (
            <>
              <Row icon={Users2}>
                <p className="mb-1.5 text-xs text-muted-foreground">Hosted by {item.host?.name} · {item.participantCount} participant{item.participantCount === 1 ? "" : "s"}</p>
                <PeopleList people={item.participants} />
                {item.participantCount > item.participants.length ? <p className="mt-1 text-xs text-muted-foreground">+{item.participantCount - item.participants.length} more</p> : null}
              </Row>
              <Row icon={Video}>{item.status}{item.hasEndTime === false ? " · no end time set" : ""}</Row>
            </>
          ) : null}

          {isEvent ? (
            detailQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : detail ? (
              <>
                <Row icon={Users2}>
                  <p className="mb-1.5 text-xs text-muted-foreground">Organised by {detail.owner.name}{detail.team ? ` · ${detail.team.name}` : ""}</p>
                  <PeopleList people={detail.attendees} />
                  {detail.attendees.length === 0 ? <p className="text-xs text-muted-foreground">No invitees</p> : null}
                </Row>
                {detail.reminders.length ? (
                  <Row icon={Bell}>
                    <ul className="space-y-0.5">
                      {detail.reminders.map((reminder) => (
                        <li key={reminder.minutesBefore}>{reminderLabel(reminder.minutesBefore)}{reminder.email ? " · also by email" : ""}</li>
                      ))}
                    </ul>
                  </Row>
                ) : null}

                {detail.myStatus ? (
                  <div className="space-y-1.5 rounded-lg border border-border p-3" role="group" aria-label="Your response">
                    <p className="text-xs font-medium text-foreground">Your response: <span className="capitalize">{detail.myStatus}</span></p>
                    <div className="flex flex-wrap gap-2">
                      {["accepted", "tentative", "declined"].map((status) => (
                        <Button key={status} size="sm" variant={detail.myStatus === status ? "secondary" : "outline"} disabled={rsvp.isPending || role === "guest"} onClick={() => respond(status)}>
                          {pendingStatus === status ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          {status === "accepted" ? "Yes" : status === "tentative" ? "Maybe" : "No"}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {detail.canManage ? (
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" onClick={() => onEdit(item, detail)}><Pencil className="size-4" />Edit</Button>
                    <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => onDelete(item, detail)}><Trash2 className="size-4" />Delete</Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">You can view this event but not change it.</p>
                )}
              </>
            ) : (
              <p role="alert" className="text-sm text-destructive">Couldn’t load this event. It may have been removed.</p>
            )
          ) : (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{SOURCE_NOTE[item.source]}</p>
          )}
        </div>

        {item.source !== "event" ? (
          <div className="flex flex-wrap gap-2 border-t border-border p-4">
            {item.canJoin ? (
              <Button asChild><Link href={item.joinLink}><Video className="size-4" />Join now</Link></Button>
            ) : null}
            <Button variant={item.canJoin ? "outline" : "default"} asChild>
              <Link href={item.link}>{item.source === "meeting" ? "Open meeting" : item.source === "task" ? "Open task" : "Open project"}</Link>
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
