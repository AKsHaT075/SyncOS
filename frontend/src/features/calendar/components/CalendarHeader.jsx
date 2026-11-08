"use client";

import { ChevronLeft, ChevronRight, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { VIEWS } from "@/features/calendar/constants/calendarOptions";
import { zoneLabel } from "@/features/calendar/utils/dates";

export default function CalendarHeader({
  title, todayLabel, view, onViewChange, onPrev, onNext, onToday, search, onSearchChange, onCreate, onSettings, filters, timeZone,
}) {
  return (
    <header className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onToday}>Today</Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={onPrev} aria-label="Previous"><ChevronLeft className="size-4" /></Button>
            <Button variant="ghost" size="icon" onClick={onNext} aria-label="Next"><ChevronRight className="size-4" /></Button>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl" aria-live="polite">{title}</h1>
            <p className="text-xs text-muted-foreground">
              Today is {todayLabel} · times in {timeZone.replace(/_/g, " ")} ({zoneLabel(timeZone)})
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search calendar…"
              aria-label="Search the calendar"
              className="w-44 pl-8 sm:w-56"
            />
          </div>
          {filters}
          <Button variant="outline" size="icon" onClick={onSettings} aria-label="Calendar settings"><Settings className="size-4" /></Button>
          <Can permission={PERMISSIONS.CREATE_EVENT}>
            <Button onClick={() => onCreate()}><Plus className="size-4" />New event</Button>
          </Can>
        </div>
      </div>

      <Tabs value={view} onValueChange={onViewChange}>
        <TabsList>
          {VIEWS.map((option) => <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
    </header>
  );
}
