"use client";

import { cn } from "@/lib/utils";
import { categoriesForScope } from "@/features/calendar/constants/calendarOptions";

/** Show/hide categories. Hidden ones are not even requested from the server. */
export default function CalendarLegend({ scope, hidden, onToggle }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Calendar categories">
      {categoriesForScope(scope).map((category) => {
        const visible = !hidden.includes(category.value);
        return (
          <button
            key={category.value}
            type="button"
            aria-pressed={visible}
            onClick={() => onToggle(category.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              visible ? "border-border bg-card text-foreground" : "border-dashed border-border text-muted-foreground line-through opacity-70",
            )}
          >
            <span className={cn("size-2 rounded-full", visible ? category.dot : "bg-muted-foreground/40")} aria-hidden="true" />
            {category.label}
          </button>
        );
      })}
    </div>
  );
}
