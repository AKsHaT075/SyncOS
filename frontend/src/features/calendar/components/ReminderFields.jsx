"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MAX_REMINDERS, REMINDER_PRESETS } from "@/features/calendar/constants/calendarOptions";

const CUSTOM = "custom";
const isPreset = (minutes) => REMINDER_PRESETS.some((preset) => preset.value === Number(minutes));

/** Up to 5 reminders: a preset or a custom number of minutes, each optionally also emailed. */
export default function ReminderFields({ value, onChange, error }) {
  const update = (index, patch) => onChange(value.map((reminder, i) => (i === index ? { ...reminder, ...patch } : reminder)));

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-foreground">Reminders</legend>
      {value.map((reminder, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            value={isPreset(reminder.minutesBefore) ? String(reminder.minutesBefore) : CUSTOM}
            onValueChange={(next) => update(index, { minutesBefore: next === CUSTOM ? 45 : Number(next) })}
          >
            <SelectTrigger className="w-44" aria-label={`Reminder ${index + 1}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {REMINDER_PRESETS.map((preset) => <SelectItem key={preset.value} value={String(preset.value)}>{preset.label}</SelectItem>)}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {!isPreset(reminder.minutesBefore) ? (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Input type="number" min={1} max={10080} className="w-24" value={reminder.minutesBefore} aria-label="Custom reminder in minutes"
                onChange={(event) => update(index, { minutesBefore: event.target.value })} />
              min before
            </span>
          ) : null}
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={reminder.email} onCheckedChange={(email) => update(index, { email })} aria-label="Also send this reminder by email" />
            Email too
          </label>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove reminder ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      {value.length < MAX_REMINDERS ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { minutesBefore: value.length ? 30 : 15, email: false }])}>
          <Plus className="size-4" />Add reminder
        </Button>
      ) : null}
      {error ? <p role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
    </fieldset>
  );
}
