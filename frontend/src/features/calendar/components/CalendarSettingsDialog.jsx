"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_TIME_ZONE, VIEWS, WEEK_START_OPTIONS } from "@/features/calendar/constants/calendarOptions";
import { allTimeZones, zoneLabel } from "@/features/calendar/utils/dates";

const SOURCE_TEXT = {
  user: "Your saved timezone.",
  organization: "Your organization's default timezone.",
  default: "The default (India Standard Time) — pick another to override it.",
};

export default function CalendarSettingsDialog({ open, onOpenChange, preferences, isPending, onSave }) {
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [weekStartsOn, setWeekStartsOn] = useState(preferences.weekStartsOn);
  const [defaultView, setDefaultView] = useState(preferences.defaultView);

  useEffect(() => {
    if (open) {
      setTimezone(preferences.timezone);
      setWeekStartsOn(preferences.weekStartsOn);
      setDefaultView(preferences.defaultView);
    }
  }, [open, preferences]);

  const zones = useMemo(() => [...new Set([timezone, DEFAULT_TIME_ZONE, "UTC", ...allTimeZones()])], [timezone]);

  const save = async () => {
    try {
      await onSave({ timezone, weekStartsOn, defaultView });
      onOpenChange(false);
    } catch {
      /* toast already shown */
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Calendar settings</DialogTitle>
          <DialogDescription>Saved for you only.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="set-tz" className="text-xs font-medium text-foreground">Timezone</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="set-tz" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {zones.map((zone) => <SelectItem key={zone} value={zone}>{zone.replace(/_/g, " ")} ({zoneLabel(zone)})</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Every time on the calendar is shown in this zone. {timezone === preferences.timezone ? SOURCE_TEXT[preferences.timezoneSource] : "Events keep their own timezone; only how you see them changes."}
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="set-week" className="text-xs font-medium text-foreground">Week starts on</label>
            <Select value={String(weekStartsOn)} onValueChange={(value) => setWeekStartsOn(Number(value))}>
              <SelectTrigger id="set-week" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{WEEK_START_OPTIONS.map((option) => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="set-view" className="text-xs font-medium text-foreground">Default view</label>
            <Select value={defaultView} onValueChange={setDefaultView}>
              <SelectTrigger id="set-view" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{VIEWS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={save} disabled={isPending}>{isPending ? <Loader2 className="size-4 animate-spin" /> : null}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
