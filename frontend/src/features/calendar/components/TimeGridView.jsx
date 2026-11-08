"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import ItemChip from "@/features/calendar/components/ItemChip";
import { formatHourLabel, formatTime, formatYmd, minutesInZone, weekdayLabel, weekdayOf } from "@/features/calendar/utils/dates";
import { bucketByDay, categoryOf, isCancelled, isMuted, splitAllDay } from "@/features/calendar/utils/items";
import { layoutDay } from "@/features/calendar/utils/layout";

const HOUR_PX = 52;
const GUTTER = "w-14 shrink-0";

/**
 * Week and day views: seven (or one) day columns on an hour grid. Event height is its duration and
 * overlapping events share the column width. All-day items (tasks, project deadlines, all-day events)
 * sit in a row above the grid. Positions come from the VIEWER's timezone wall clock.
 */
export default function TimeGridView({ days, items, timeZone, today, onOpen, onCreateAt, onOpenDay }) {
  const scroller = useRef(null);
  const [nowMinutes, setNowMinutes] = useState(() => minutesInZone(Date.now(), timeZone));

  useEffect(() => {
    const tick = () => setNowMinutes(minutesInZone(Date.now(), timeZone));
    tick();
    const timer = setInterval(tick, 60 * 1000);
    return () => clearInterval(timer);
  }, [timeZone]);

  // Start near the working day rather than at midnight.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, [days[0]]);

  const buckets = bucketByDay(items, timeZone);
  const hasAllDay = days.some((day) => splitAllDay(buckets.get(day) ?? []).allDay.length > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm" role="grid" aria-label={days.length === 1 ? "Day" : "Week"}>
      <div className="flex border-b border-border bg-muted/40" role="row">
        <div className={GUTTER} />
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((day) => {
            const isToday = day === today;
            return (
              <button
                key={day}
                type="button"
                role="columnheader"
                onClick={() => onOpenDay?.(day)}
                className="flex flex-col items-center gap-0.5 border-l border-border py-2 first:border-l-0 focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={formatYmd(day, { weekday: "long", month: "long", day: "numeric" })}
              >
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{weekdayLabel(weekdayOf(day))}</span>
                <span className={cn("flex size-7 items-center justify-center rounded-full text-sm font-semibold", isToday ? "bg-primary text-primary-foreground" : "text-foreground")}>
                  {Number(day.slice(8))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {hasAllDay ? (
        <div className="flex border-b border-border" role="row">
          <div className={cn(GUTTER, "px-1 py-1.5 text-right text-[10px] font-medium text-muted-foreground uppercase")}>All day</div>
          <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((day) => (
              <div key={day} role="gridcell" className="min-w-0 space-y-0.5 border-l border-border p-1 first:border-l-0">
                {splitAllDay(buckets.get(day) ?? []).allDay.map((item) => (
                  <ItemChip key={`${item.id}-${day}`} item={item} timeZone={timeZone} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={scroller} className="max-h-[68vh] overflow-y-auto">
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          <div className={cn(GUTTER, "relative")}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="absolute right-2 -translate-y-2 text-[10px] text-muted-foreground" style={{ top: hour * HOUR_PX }}>
                {formatHourLabel(hour)}
              </div>
            ))}
          </div>

          <div className="relative grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ top: hour * HOUR_PX }} />
            ))}

            {days.map((day) => {
              const placed = layoutDay(splitAllDay(buckets.get(day) ?? []).timed, day, timeZone);
              const isToday = day === today;
              return (
                <div
                  key={day}
                  role="gridcell"
                  className={cn("relative border-l border-border first:border-l-0", isToday && "bg-primary/[0.03]")}
                  onClick={(event) => {
                    if (!onCreateAt) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const minutes = Math.floor(((event.clientY - rect.top) / HOUR_PX) * 60 / 30) * 30; // snap to 30 min
                    onCreateAt(day, Math.max(0, Math.min(minutes, 23 * 60 + 30)));
                  }}
                >
                  {placed.map(({ item, top, height, left, width }) => {
                    const category = categoryOf(item);
                    return (
                      <button
                        key={`${item.id}-${day}`}
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onOpen(item); }}
                        className={cn(
                          "absolute overflow-hidden rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm transition-colors hover:brightness-95 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                          category.chip, isMuted(item) && "opacity-60",
                        )}
                        style={{ top: (top / 60) * HOUR_PX, height: Math.max((height / 60) * HOUR_PX - 2, 18), left: `calc(${left}% + 1px)`, width: `calc(${width}% - 3px)` }}
                        title={`${item.title}${isCancelled(item) ? " (cancelled)" : ""}`}
                      >
                        <span className={cn("block truncate font-semibold", isMuted(item) && "line-through")}>{item.title}</span>
                        {height >= 40 ? (
                          <span className="block truncate opacity-80">{formatTime(item.start, timeZone)} – {formatTime(item.end, timeZone)}</span>
                        ) : null}
                      </button>
                    );
                  })}
                  {isToday ? (
                    <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: (nowMinutes / 60) * HOUR_PX }} aria-hidden="true">
                      <span className="-ml-1 size-2 rounded-full bg-red-500" />
                      <span className="h-px flex-1 bg-red-500" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
