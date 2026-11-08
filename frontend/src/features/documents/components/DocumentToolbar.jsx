"use client";

import { ArrowDownAZ, ArrowUpAZ, LayoutGrid, List, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePeople } from "@/features/people/hooks/usePeople";
import { CATEGORY_OPTIONS, SCOPE_OPTIONS, SORT_OPTIONS } from "@/features/documents/constants/documentOptions";

const ALL = "all";

export default function DocumentToolbar({ filters, onChange, onClear, hasActiveFilters, view, onViewChange }) {
  const { data: peopleData } = usePeople({ limit: 100 });
  const people = (peopleData?.people ?? []).filter((person) => person.isActive);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder="Search all documents by name…"
            aria-label="Search documents"
            className="bg-background/50 pl-9"
          />
        </div>
        <Tabs value={filters.scope} onValueChange={(scope) => onChange({ scope })}>
          <TabsList>
            {SCOPE_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1 self-end rounded-lg border border-border bg-background/50 p-1 lg:self-auto">
          <Button variant={view === "table" ? "secondary" : "ghost"} size="icon-sm" onClick={() => onViewChange("table")} aria-label="Table view" aria-pressed={view === "table"}>
            <List className="size-4" />
          </Button>
          <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon-sm" onClick={() => onViewChange("grid")} aria-label="Grid view" aria-pressed={view === "grid"}>
            <LayoutGrid className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Select value={filters.category || ALL} onValueChange={(value) => onChange({ category: value === ALL ? "" : value })}>
          <SelectTrigger className="w-full" aria-label="File type"><SelectValue placeholder="File type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All file types</SelectItem>
            {CATEGORY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.ownerId || ALL} onValueChange={(value) => onChange({ ownerId: value === ALL ? "" : value })}>
          <SelectTrigger className="w-full" aria-label="Owner"><SelectValue placeholder="Owner" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any owner</SelectItem>
            {people.map((person) => <SelectItem key={person.id} value={person.id}>{person.fullName}</SelectItem>)}
          </SelectContent>
        </Select>

        <Input type="date" value={filters.uploadedFrom} max={filters.uploadedTo || undefined} onChange={(event) => onChange({ uploadedFrom: event.target.value })} aria-label="Uploaded from" title="Uploaded from" />
        <Input type="date" value={filters.uploadedTo} min={filters.uploadedFrom || undefined} onChange={(event) => onChange({ uploadedTo: event.target.value })} aria-label="Uploaded to" title="Uploaded to" />

        <Select value={filters.sortBy} onValueChange={(sortBy) => onChange({ sortBy })}>
          <SelectTrigger className="w-full" aria-label="Sort by"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>Sort: {option.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onChange({ sortOrder: filters.sortOrder === "asc" ? "desc" : "asc" })}
            aria-label={`Sort order: ${filters.sortOrder === "asc" ? "ascending" : "descending"}`}
          >
            {filters.sortOrder === "asc" ? <ArrowUpAZ className="size-4" /> : <ArrowDownAZ className="size-4" />}
            {filters.sortOrder === "asc" ? "Asc" : "Desc"}
          </Button>
          {hasActiveFilters ? (
            <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear filters" title="Clear filters"><X className="size-4" /></Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
