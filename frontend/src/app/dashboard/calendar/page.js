"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { PERMISSIONS } from "@/constants/permissions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import ConfirmDialog from "@/features/documents/components/ConfirmDialog";
import AgendaView from "@/features/calendar/components/AgendaView";
import CalendarFilters from "@/features/calendar/components/CalendarFilters";
import CalendarHeader from "@/features/calendar/components/CalendarHeader";
import CalendarLegend from "@/features/calendar/components/CalendarLegend";
import CalendarSettingsDialog from "@/features/calendar/components/CalendarSettingsDialog";
import EventFormDialog from "@/features/calendar/components/EventFormDialog";
import ItemDetailsSheet from "@/features/calendar/components/ItemDetailsSheet";
import MonthView from "@/features/calendar/components/MonthView";
import ScopeChoiceDialog from "@/features/calendar/components/ScopeChoiceDialog";
import TimeGridView from "@/features/calendar/components/TimeGridView";
import { DEFAULT_TIME_ZONE, categoriesForScope } from "@/features/calendar/constants/calendarOptions";
import {
  useCalendarEvent,
  useCalendarItems,
  useCalendarPreferences,
  useCreateEvent,
  useDeleteEvent,
  useUpdateCalendarPreferences,
  useUpdateEvent,
} from "@/features/calendar/hooks/calendarHooks";
import {
  addDays,
  addMonths,
  formatDayLong,
  formatDayShort,
  formatMonthYear,
  monthGrid,
  startOfWeek,
  todayYmd,
  ymdInZone,
} from "@/features/calendar/utils/dates";
import { buildPayload, createDefaults, valuesFromEvent } from "@/features/calendar/utils/eventForm";

const AGENDA_STEP = 30;
const AGENDA_MAX = 90;
const VIEW_VALUES = ["month", "week", "day", "agenda"];

function rangeFor(view, anchor, weekStartsOn, agendaDays) {
  if (view === "month") {
    const grid = monthGrid(anchor, weekStartsOn);
    return { start: grid.start, end: grid.end, days: grid.days };
  }
  if (view === "week") {
    const start = startOfWeek(anchor, weekStartsOn);
    return { start, end: addDays(start, 6), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
  }
  if (view === "day") return { start: anchor, end: anchor, days: [anchor] };
  return { start: anchor, end: addDays(anchor, agendaDays - 1), days: [] };
}

function titleFor(view, range, anchor) {
  if (view === "month") return formatMonthYear(anchor);
  if (view === "day") return formatDayLong(anchor);
  if (view === "week") return `${formatDayShort(range.start)} – ${formatDayShort(range.end)}`;
  return "Agenda";
}

function CalendarPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canCreate = usePermission(PERMISSIONS.CREATE_EVENT);

  const { data: prefData, isLoading: prefsLoading } = useCalendarPreferences();
  const preferences = prefData?.preferences;
  const timeZone = preferences?.timezone ?? DEFAULT_TIME_ZONE;
  const weekStartsOn = preferences?.weekStartsOn ?? 1;
  const today = todayYmd(timeZone);

  // ---- URL state: view, date, scope and filters survive reloads and can be shared
  const param = (key, fallback = "") => searchParams.get(key) ?? fallback;
  const view = VIEW_VALUES.includes(param("view")) ? param("view") : preferences?.defaultView ?? "month";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(param("date")) ? param("date") : today;
  const scope = ["personal", "team", "organization"].includes(param("scope")) ? param("scope") : "personal";
  const filters = {
    scope, teamId: param("team"), projectId: param("project"), assigneeId: param("assignee"),
    status: param("status"), includeCancelled: param("cancelled") === "1",
  };

  const setParams = useCallback((patch) => {
    const next = new URLSearchParams(searchParams.toString());
    Object.entries(patch).forEach(([key, value]) => {
      if (value === "" || value === null || value === undefined || value === false) next.delete(key);
      else next.set(key, value === true ? "1" : String(value));
    });
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput);
  const [agendaDays, setAgendaDays] = useState(AGENDA_STEP);
  const [hidden, setHidden] = useState(null); // null = use the saved preference
  const hiddenCategories = hidden ?? preferences?.hiddenCategories ?? [];

  // Team scope needs a team: default to the first one available.
  const { data: teamsData } = useTeams({ limit: 100 });
  const firstTeam = teamsData?.teams?.[0]?.id;
  useEffect(() => {
    if (scope === "team" && !filters.teamId && firstTeam) setParams({ team: firstTeam });
  }, [scope, filters.teamId, firstTeam]);

  const range = useMemo(() => rangeFor(view, anchor, weekStartsOn, agendaDays), [view, anchor, weekStartsOn, agendaDays]);

  const visibleCategories = categoriesForScope(scope).map((c) => c.value).filter((value) => !hiddenCategories.includes(value));
  const needsTeam = scope === "team" && !filters.teamId;
  const queryParams = {
    fromDate: range.start, toDate: range.end, tz: timeZone, scope,
    types: visibleCategories.join(","),
    ...(filters.teamId && scope === "team" ? { teamId: filters.teamId } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(search ? { q: search } : {}),
    ...(filters.includeCancelled ? { includeCancelled: "true" } : {}),
  };
  const itemsQuery = useCalendarItems(queryParams, { enabled: Boolean(preferences) && visibleCategories.length > 0 && !needsTeam });
  const items = visibleCategories.length ? itemsQuery.data?.items ?? [] : [];

  // ---- dialogs
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(null); // { mode, scope, initial, item, detail }
  const [scopeChoice, setScopeChoice] = useState(null); // { action, item, detail }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const createEvent = useCreateEvent();
  const updateEvent = useUpdateEvent();
  const deleteEvent = useDeleteEvent();
  const updatePreferences = useUpdateCalendarPreferences();

  // Deep link from a notification: /dashboard/calendar?event=<id> opens that event and jumps to its date.
  const eventParam = param("event");
  const deepLinked = useCalendarEvent(eventParam || null);
  useEffect(() => {
    const event = deepLinked.data?.event;
    if (!event || selected?.eventId === event.id) return;
    const date = event.allDay ? event.startDate : ymdInZone(new Date(event.start).getTime(), timeZone);
    setSelected({
      id: `event:${event.id}`, source: "event", eventId: event.id, category: event.type, title: event.title, description: event.description,
      location: event.location, meetingUrl: event.meetingUrl, allDay: event.allDay, start: event.start, end: event.end,
      startDate: event.startDate, endDate: event.endDate, recurring: Boolean(event.recurrence), occurrenceStart: null,
    });
    setParams({ date });
  }, [deepLinked.data, timeZone]);

  const closeDetails = (open) => {
    if (open) return;
    setSelected(null);
    if (eventParam) setParams({ event: "" });
  };

  // ---- navigation
  const step = (direction) => {
    if (view === "month") setParams({ date: addMonths(anchor, direction) });
    else if (view === "week") setParams({ date: addDays(anchor, 7 * direction) });
    else if (view === "day") setParams({ date: addDays(anchor, direction) });
    else { setParams({ date: addDays(anchor, AGENDA_STEP * direction) }); setAgendaDays(AGENDA_STEP); }
  };
  const openDay = (day) => setParams({ view: "day", date: day });

  // ---- create / edit / delete
  // "New event" from the header starts today (or the focused day); clicking a slot/day starts there.
  const defaultDate = view === "month" && anchor.slice(0, 7) === today.slice(0, 7) ? today : anchor;
  const openCreate = ({ date = defaultDate, minutes } = {}) => {
    if (!canCreate) return;
    setForm({ mode: "create", scope: "series", initial: createDefaults({ date, minutes, timeZone }) });
  };

  const startEdit = (item, detail, chosenScope) => {
    setSelected(null);
    setForm({ mode: "edit", scope: chosenScope, item, detail, initial: valuesFromEvent(detail, { scope: chosenScope, item }) });
  };
  const requestEdit = (item, detail) => (detail.recurrence ? setScopeChoice({ action: "edit", item, detail }) : startEdit(item, detail, "series"));
  const requestDelete = (item, detail) => (detail.recurrence ? setScopeChoice({ action: "delete", item, detail }) : setConfirmDelete({ item, detail, scope: "series" }));

  const chooseScope = (chosen) => {
    const { action, item, detail } = scopeChoice;
    setScopeChoice(null);
    if (action === "edit") startEdit(item, detail, chosen);
    else setConfirmDelete({ item, detail, scope: chosen });
  };

  const submitForm = async (values) => {
    const body = buildPayload(values, { mode: form.mode, scope: form.scope });
    if (form.mode === "create") {
      await createEvent.mutateAsync(body);
      return;
    }
    await updateEvent.mutateAsync({
      id: form.item.eventId,
      body: form.scope === "occurrence"
        ? { ...body, scope: "occurrence", occurrenceStart: String(form.item.occurrenceStart) }
        : { ...body, scope: "series" },
    });
  };

  const confirmDeletion = async () => {
    const { item, scope: deleteScope } = confirmDelete;
    try {
      await deleteEvent.mutateAsync({
        id: item.eventId,
        params: deleteScope === "occurrence" ? { scope: "occurrence", occurrenceStart: String(item.occurrenceStart) } : {},
      });
      setConfirmDelete(null);
      setSelected(null);
    } catch {
      /* toast already shown */
    }
  };

  const toggleCategory = (value) => {
    const next = hiddenCategories.includes(value) ? hiddenCategories.filter((c) => c !== value) : [...hiddenCategories, value];
    setHidden(next);
    updatePreferences.mutate({ hiddenCategories: next });
  };

  // Filter state lives in the URL under short names.
  const FILTER_PARAMS = { scope: "scope", teamId: "team", projectId: "project", assigneeId: "assignee", status: "status", includeCancelled: "cancelled" };
  const changeFilters = (patch) => setParams(Object.fromEntries(Object.entries(patch).map(([key, value]) => [FILTER_PARAMS[key], value])));
  const resetFilters = () => setParams({ project: "", assignee: "", status: "", cancelled: false });

  // ---- render
  if (prefsLoading) {
    return <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6"><Skeleton className="h-16 w-full" /><Skeleton className="h-[32rem] w-full rounded-xl" /></div>;
  }

  const showSkeleton = itemsQuery.isLoading && !needsTeam;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <CalendarHeader
        title={titleFor(view, range, anchor)}
        todayLabel={formatDayLong(today)}
        view={view}
        onViewChange={(next) => setParams({ view: next })}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onToday={() => { setParams({ date: "" }); setAgendaDays(AGENDA_STEP); }}
        search={searchInput}
        onSearchChange={setSearchInput}
        onCreate={() => openCreate()}
        onSettings={() => setSettingsOpen(true)}
        timeZone={timeZone}
        filters={<CalendarFilters filters={filters} onChange={changeFilters} onReset={resetFilters} />}
      />

      <CalendarLegend scope={scope} hidden={hiddenCategories} onToggle={toggleCategory} />

      {itemsQuery.data?.truncated ? (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          This period has more items than can be shown. Narrow the dates or use filters to see everything.
        </p>
      ) : null}

      {needsTeam ? (
        <Card className="py-12"><EmptyStateCard icon={AlertCircle} title="Choose a team" description="Open Filters and pick the team whose calendar you want to see." /></Card>
      ) : visibleCategories.length === 0 ? (
        <Card className="py-12"><EmptyStateCard icon={AlertCircle} title="Everything is hidden" description="Turn a category back on in the legend above." /></Card>
      ) : itemsQuery.isError ? (
        <Card className="py-12">
          <EmptyStateCard icon={AlertCircle} title="Couldn’t load the calendar" description={itemsQuery.error?.response?.data?.message || "Check your connection and try again."} />
          <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => itemsQuery.refetch()}>Retry</Button></div>
        </Card>
      ) : showSkeleton ? (
        <Skeleton className="h-[34rem] w-full rounded-xl" aria-busy="true" aria-label="Loading calendar" />
      ) : (
        <div className={itemsQuery.isPlaceholderData ? "opacity-70 transition-opacity" : undefined} aria-busy={itemsQuery.isFetching}>
          {view === "month" ? (
            <MonthView days={range.days} anchor={anchor} today={today} items={items} timeZone={timeZone} weekStartsOn={weekStartsOn}
              onOpen={setSelected} onOpenDay={openDay} onCreateOn={canCreate ? (day) => openCreate({ date: day }) : undefined} />
          ) : view === "agenda" ? (
            <AgendaView start={range.start} end={range.end} items={items} timeZone={timeZone} today={today} onOpen={setSelected}
              canLoadMore={agendaDays < AGENDA_MAX} onLoadMore={() => setAgendaDays((days) => Math.min(days + AGENDA_STEP, AGENDA_MAX))} />
          ) : (
            <TimeGridView days={range.days} items={items} timeZone={timeZone} today={today} onOpen={setSelected} onOpenDay={view === "week" ? openDay : undefined}
              onCreateAt={canCreate ? (day, minutes) => openCreate({ date: day, minutes }) : undefined} />
          )}
        </div>
      )}

      <ItemDetailsSheet item={selected} open={Boolean(selected)} onOpenChange={closeDetails} timeZone={timeZone} onEdit={requestEdit} onDelete={requestDelete} />

      {form ? (
        <EventFormDialog
          open
          onOpenChange={(open) => !open && setForm(null)}
          mode={form.mode}
          scope={form.scope}
          initial={form.initial}
          isPending={createEvent.isPending || updateEvent.isPending}
          onSubmit={submitForm}
        />
      ) : null}

      <ScopeChoiceDialog
        open={Boolean(scopeChoice)}
        onOpenChange={(open) => !open && setScopeChoice(null)}
        action={scopeChoice?.action}
        title={scopeChoice?.item?.title}
        onChoose={chooseScope}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.item?.title}”?`}
        description={confirmDelete?.scope === "occurrence" ? "Only this occurrence is removed; the rest of the series stays." : "Invitees are notified that it was cancelled."}
        confirmLabel="Delete"
        destructive
        isPending={deleteEvent.isPending}
        onConfirm={confirmDeletion}
      />

      {preferences ? (
        <CalendarSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          preferences={preferences}
          isPending={updatePreferences.isPending}
          onSave={(updates) => updatePreferences.mutateAsync(updates)}
        />
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-[1400px] p-6"><Skeleton className="h-[34rem] w-full rounded-xl" /></div>}>
      <CalendarPage />
    </Suspense>
  );
}
