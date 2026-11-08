"use client";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatYmd, weekdayLabel, weekdayOf } from "@/features/calendar/utils/dates";

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth"];
const UNIT = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)" };

/** Daily / weekly / monthly rules with an interval, weekdays, monthly by date or by "Nth weekday", and an end. */
export default function RecurrenceFields({ value, onChange, startDate, errors = {} }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const weekday = weekdayOf(startDate);
  const day = Number(startDate.slice(8));
  const nth = day > 28 ? "last" : ORDINAL[Math.ceil(day / 7)];

  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-medium text-foreground">Repeat</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={value.repeat} onValueChange={(repeat) => set({ repeat, byWeekday: value.byWeekday.length ? value.byWeekday : [weekday] })}>
          <SelectTrigger className="w-40" aria-label="Repeat"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Does not repeat</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </Select>
        {value.repeat !== "none" ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            every
            <Input type="number" min={1} max={99} className="w-16" value={value.interval} aria-label="Repeat every"
              onChange={(event) => set({ interval: event.target.value })} />
            {UNIT[value.repeat]}
          </span>
        ) : null}
      </div>
      {errors.interval ? <p role="alert" className="text-xs font-medium text-destructive">{errors.interval}</p> : null}

      {value.repeat === "weekly" ? (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat on">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const on = value.byWeekday.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ byWeekday: on ? value.byWeekday.filter((x) => x !== d) : [...value.byWeekday, d] })}
                  className={cn("size-9 rounded-full border text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted")}
                  title={weekdayLabel(d, "long")}
                >
                  {weekdayLabel(d, "narrow")}
                </button>
              );
            })}
          </div>
          {errors.byWeekday ? <p role="alert" className="text-xs font-medium text-destructive">{errors.byWeekday}</p> : null}
        </div>
      ) : null}

      {value.repeat === "monthly" ? (
        <Select value={value.monthlyMode} onValueChange={(monthlyMode) => set({ monthlyMode })}>
          <SelectTrigger className="w-full sm:w-72" aria-label="Monthly repeat"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="date">On day {day} of the month</SelectItem>
            <SelectItem value="nthWeekday">On the {nth} {formatYmd(startDate, { weekday: "long" })}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      {value.repeat !== "none" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={value.end} onValueChange={(end) => set({ end })}>
            <SelectTrigger className="w-40" aria-label="Ends"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="never">Never ends</SelectItem>
              <SelectItem value="until">Ends on a date</SelectItem>
              <SelectItem value="count">After N times</SelectItem>
            </SelectContent>
          </Select>
          {value.end === "until" ? <Input type="date" className="w-44" value={value.until} min={startDate} onChange={(event) => set({ until: event.target.value })} aria-label="Repeat until" /> : null}
          {value.end === "count" ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Input type="number" min={1} max={1000} className="w-20" value={value.count} onChange={(event) => set({ count: event.target.value })} aria-label="Number of occurrences" />times
            </span>
          ) : null}
        </div>
      ) : null}
      {errors.until || errors.count ? <p role="alert" className="text-xs font-medium text-destructive">{errors.until || errors.count}</p> : null}
    </fieldset>
  );
}
