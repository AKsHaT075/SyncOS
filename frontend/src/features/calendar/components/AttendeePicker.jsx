"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePeople } from "@/features/people/hooks/usePeople";

/** Search the organization's directory and invite people. The server re-validates every invitee. */
export default function AttendeePicker({ value, onChange, excludeId }) {
  const [input, setInput] = useState("");
  const search = useDebouncedValue(input);
  const { data, isFetching } = usePeople({ search: search || undefined, limit: 6 });
  const chosen = new Set(value.map((person) => person.id));
  const options = (data?.people ?? []).filter((person) => person.isActive && !person.orgBlocked && person.id !== excludeId && !chosen.has(person.id));

  return (
    <div className="space-y-2">
      <label htmlFor="attendee-search" className="text-xs font-medium text-foreground">Invite people</label>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Invited people">
          {value.map((person) => (
            <li key={person.id}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {person.name}
                <button type="button" aria-label={`Remove ${person.name}`} onClick={() => onChange(value.filter((p) => p.id !== person.id))} className="rounded-full p-0.5 hover:bg-background/60">
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Input id="attendee-search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search by name or email…" autoComplete="off" />
      {input ? (
        <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{isFetching ? "Searching…" : "No one else matches."}</li>
          ) : options.map((person) => (
            <li key={person.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="min-w-0 text-sm"><span className="block truncate font-medium text-foreground">{person.fullName}</span><span className="block truncate text-xs text-muted-foreground">{person.email}</span></span>
              <Button type="button" size="sm" variant="outline" onClick={() => { onChange([...value, { id: person.id, name: person.fullName }]); setInput(""); }}>Add</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
