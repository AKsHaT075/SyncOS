"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Building2, FolderKanban, Loader2, Lock, Users2, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePeople } from "@/features/people/hooks/usePeople";
import { useAddShare, useDocumentShares, useRevokeShare } from "@/features/documents/hooks/documentHooks";

const AUDIENCE = {
  private: { icon: Lock, text: "Only the owner and the people below" },
  team: { icon: Users2, text: "Members of the team" },
  project: { icon: FolderKanban, text: "Members of the project" },
  organization: { icon: Building2, text: "Everyone in the organization (guests excluded)" },
};

const initials = (name) => name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();

function PersonRow({ person, children }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar className="size-8"><AvatarFallback className="text-xs">{initials(person.fullName)}</AvatarFallback></Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{person.fullName}</p>
        <p className="truncate text-xs text-muted-foreground">{person.email}</p>
      </div>
      {children}
    </li>
  );
}

export default function ShareDialog({ open, onOpenChange, document: doc }) {
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput);
  const { data, isLoading, isError } = useDocumentShares(doc?.id, open);
  const { data: peopleData, isFetching } = usePeople({ search: search || undefined, limit: 8 });
  const addShare = useAddShare();
  const revokeShare = useRevokeShare();

  const sharedIds = useMemo(() => new Set((data?.shares ?? []).map((share) => share.user.id)), [data]);
  const candidates = (peopleData?.people ?? []).filter(
    (person) => person.isActive && !person.orgBlocked && person.id !== data?.owner?.id && !sharedIds.has(person.id),
  );

  const audience = AUDIENCE[data?.visibility] ?? AUDIENCE.private;
  const AudienceIcon = audience.icon;
  const audienceTarget = data?.team?.name ?? data?.project?.name;

  const grant = (person, permission) =>
    addShare.mutate({ id: doc.id, userId: person.id, permission: person.role === "guest" ? "viewer" : permission });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{doc?.name}”</DialogTitle>
          <DialogDescription>Give specific people access. Viewers can read and download; editors can also rename and upload new versions.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="share-search" className="text-xs font-medium text-foreground">Add people</label>
          <Input
            id="share-search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by name or email…"
            autoComplete="off"
          />
          {searchInput ? (
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border px-3" aria-label="Search results">
              {isFetching && candidates.length === 0 ? (
                <li className="py-3 text-sm text-muted-foreground">Searching…</li>
              ) : candidates.length === 0 ? (
                <li className="py-3 text-sm text-muted-foreground">No one else matches.</li>
              ) : (
                candidates.map((person) => (
                  <PersonRow key={person.id} person={person}>
                    <Button size="sm" variant="outline" disabled={addShare.isPending} onClick={() => grant(person, "viewer")}>
                      Add as viewer
                    </Button>
                  </PersonRow>
                ))
              )}
            </ul>
          ) : null}
        </div>

        <section aria-label="People with access" className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Who has access</h3>
          {isError ? (
            <p role="alert" className="text-sm text-destructive">Couldn’t load who has access. Try again in a moment.</p>
          ) : isLoading || !data ? (
            <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : (
            <>
              <ul className="divide-y divide-border rounded-lg border border-border px-3">
                <PersonRow person={data.owner}><Badge variant="secondary">Owner</Badge></PersonRow>
                {data.shares.map((share) => (
                  <PersonRow key={share.user.id} person={share.user}>
                    {!share.active ? (
                      <Badge variant="outline" className="gap-1 text-amber-600"><AlertTriangle className="size-3" />No access</Badge>
                    ) : null}
                    <Select
                      value={share.permission}
                      onValueChange={(permission) => grant(share.user, permission)}
                      disabled={share.user.role === "guest" || addShare.isPending}
                    >
                      <SelectTrigger size="sm" className="w-28" aria-label={`Permission for ${share.user.fullName}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${share.user.fullName}`}
                      disabled={revokeShare.isPending}
                      onClick={() => revokeShare.mutate({ id: doc.id, userId: share.user.id })}
                    >
                      {revokeShare.isPending && revokeShare.variables?.userId === share.user.id ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                    </Button>
                  </PersonRow>
                ))}
              </ul>
              <p className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <AudienceIcon className="size-3.5 shrink-0" />
                <span>
                  Visibility: <span className="font-medium text-foreground">{audience.text}{audienceTarget ? ` “${audienceTarget}”` : ""}</span>
                </span>
              </p>
            </>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
