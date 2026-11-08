"use client";

import { cn } from "@/lib/utils";
import ItemChip from "@/features/calendar/components/ItemChip";
import { formatYmd, weekdayLabel } from "@/features/calendar/utils/dates";
import { bucketByDay, sortForDay } from "@/features/calendar/utils/items";

const MAX_CHIPS = 3;

/** Traditional month grid (6 weeks). Days with more items than fit show "+N more" → the day view. */
export default function MonthView({ days, anchor, today, items, timeZone, weekStartsOn, onOpen, onOpenDay, onCreateOn }) {
  const buckets = bucketByDay(items, timeZone);
  const anchorMonth = anchor.slice(0, 7);
  const headers = Array.from({ length: 7 }, (_, index) => weekdayLabel((weekStartsOn + index) % 7));

  return (
    <div role="grid" aria-label="Month" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div role="row" className="grid grid-cols-7 border-b border-border bg-muted/40">
        {headers.map((label) => (
          <div key={label} role="columnheader" className="px-2 py-2 text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, index) => {
          const dayItems = sortForDay(buckets.get(day) ?? []);
          const outside = day.slice(0, 7) !== anchorMonth;
          const isToday = day === today;
          const overflow = dayItems.length - MAX_CHIPS;
          return (
            <div
              key={day}
              role="gridcell"
              aria-label={`${formatYmd(day, { weekday: "long", month: "long", day: "numeric" })}, ${dayItems.length} item${dayItems.length === 1 ? "" : "s"}`}
              onClick={() => onCreateOn?.(day)}
              className={cn(
                "min-h-24 border-b border-border p-1.5 sm:min-h-28",
                index % 7 !== 6 && "border-r",
                index >= 35 && "border-b-0",
                outside && "bg-muted/30",
                onCreateOn && "cursor-pointer hover:bg-muted/40",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onOpenDay(day); }}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                    isToday ? "bg-primary text-primary-foreground" : outside ? "text-muted-foreground" : "text-foreground hover:bg-muted",
                  )}
                  aria-label={`Open ${formatYmd(day, { month: "long", day: "numeric" })}`}
                  aria-current={isToday ? "date" : undefined}
                >
                  {Number(day.slice(8))}
                </button>
              </div>
              <div className="space-y-0.5">
                {dayItems.slice(0, MAX_CHIPS).map((item) => (
                  <ItemChip key={`${item.id}-${day}`} item={item} timeZone={timeZone} onOpen={onOpen} />
                ))}
                {overflow > 0 ? (
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); onOpenDay(day); }}
                    className="w-full rounded px-1.5 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    +{overflow} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
