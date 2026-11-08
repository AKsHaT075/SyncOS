"use client";

import { Repeat, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/features/calendar/utils/dates";
import { categoryOf, isCancelled, isMuted } from "@/features/calendar/utils/items";

/** One calendar item as a compact chip (month grid, all-day rows, agenda). */
export default function ItemChip({ item, timeZone, onOpen, showTime = true, className }) {
  const category = categoryOf(item);
  const muted = isMuted(item);
  const time = !item.allDay && showTime ? formatTime(item.start, timeZone) : null;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(item);
      }}
      title={`${item.title}${isCancelled(item) ? " (cancelled)" : ""}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4 font-medium transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring",
        category.chip,
        muted && "opacity-60",
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", category.dot)} aria-hidden="true" />
      {time ? <span className="shrink-0 tabular-nums opacity-80">{time}</span> : null}
      <span className={cn("min-w-0 flex-1 truncate", muted && "line-through")}>{item.title}</span>
      {item.recurring ? <Repeat className="size-3 shrink-0 opacity-70" aria-label="Repeats" /> : null}
      {item.canJoin ? <Video className="size-3 shrink-0" aria-label="Joinable now" /> : null}
    </button>
  );
}
