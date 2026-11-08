"use client";

import { CalendarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { addDays, diffDays, formatDayLong, formatTime } from "@/features/calendar/utils/dates";
import { bucketByDay, categoryOf, isCancelled, isMuted, sortForDay } from "@/features/calendar/utils/items";
import { cn } from "@/lib/utils";

function dayHeading(day, today) {
  const offset = diffDays(today, day);
  const prefix = offset === 0 ? "Today · " : offset === 1 ? "Tomorrow · " : "";
  return `${prefix}${formatDayLong(day)}`;
}

/** Chronological list of upcoming items, grouped by date. Only days that have something are shown. */
export default function AgendaView({ start, end, items, timeZone, today, onOpen, onLoadMore, canLoadMore }) {
  const buckets = bucketByDay(items, timeZone);
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (buckets.has(day)) days.push(day);
  }

  if (days.length === 0) {
    return (
      <Card className="py-12">
        <EmptyStateCard icon={CalendarOff} title="Nothing scheduled" description="No events, meetings or deadlines in this period." />
        {canLoadMore ? <div className="flex justify-center"><Button variant="outline" size="sm" onClick={onLoadMore}>Look further ahead</Button></div> : null}
      </Card>
    );
  }

  return (
    <div className="space-y-4" aria-label="Agenda">
      {days.map((day) => (
        <section key={day} aria-labelledby={`agenda-${day}`}>
          <h2 id={`agenda-${day}`} className={cn("mb-1.5 text-sm font-semibold", day === today ? "text-primary" : "text-foreground")}>{dayHeading(day, today)}</h2>
          <Card className="gap-0 divide-y divide-border overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
            {sortForDay(buckets.get(day)).map((item) => {
              const category = categoryOf(item);
              return (
                <button
                  key={`${item.id}-${day}`}
                  type="button"
                  onClick={() => onOpen(item)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {item.allDay ? "All day" : `${formatTime(item.start, timeZone)} – ${formatTime(item.end, timeZone)}`}
                  </span>
                  <span className={cn("size-2.5 shrink-0 rounded-full", category.dot)} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm font-medium text-foreground", isMuted(item) && "text-muted-foreground line-through")}>{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {category.label}{item.project?.name ? ` · ${item.project.name}` : ""}{item.status && item.source !== "event" ? ` · ${item.status}` : ""}{isCancelled(item) ? " (cancelled)" : ""}
                    </span>
                  </span>
                  {item.canJoin ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Join now</span> : null}
                </button>
              );
            })}
          </Card>
        </section>
      ))}
      {canLoadMore ? <div className="flex justify-center"><Button variant="outline" onClick={onLoadMore}>Show more days</Button></div> : null}
    </div>
  );
}
