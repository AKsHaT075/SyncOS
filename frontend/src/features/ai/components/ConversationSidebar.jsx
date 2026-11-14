"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertCircle, Loader2, MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import ConversationActionsMenu from "@/features/ai/components/ConversationActionsMenu";
import { useConversations } from "@/features/ai/hooks/aiHooks";
import { aiErrorMessage } from "@/features/ai/utils/apiError";

const TABS = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];

/** Paginated conversation history. The server has no search endpoint, so the filter box narrows the conversations already loaded. */
export default function ConversationSidebar({ inSheet = false, selectedId, onSelect, onNew, onRename, onArchive, onDelete }) {
  const [tab, setTab] = useState("active");
  const [query, setQuery] = useState("");
  const list = useConversations({ status: tab });

  const conversations = useMemo(() => (list.data?.pages ? list.data.pages.flatMap((page) => page.conversations) : []), [list.data]);
  const needle = query.trim().toLowerCase();
  const visible = needle ? conversations.filter((c) => c.title.toLowerCase().includes(needle)) : conversations;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="space-y-3 border-b border-border p-3">
        {inSheet ? <p className="pr-8 text-sm font-semibold text-foreground">Conversations</p> : null}
        <Button type="button" className="w-full justify-center" onClick={onNew}>
          <Plus />
          New chat
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter loaded chats" aria-label="Filter loaded conversations by title" className="h-8 pl-8" />
        </div>
        <div role="tablist" aria-label="Conversation status" className="grid grid-cols-2 rounded-lg bg-muted p-0.5 text-xs font-medium">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn("rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === t.id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.isLoading ? (
          <div className="space-y-2 p-1">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
        ) : list.isError ? (
          <div role="alert" className="m-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <p className="flex items-center gap-1.5 font-medium"><AlertCircle className="size-3.5" />Could not load conversations</p>
            <p className="mt-1 text-destructive/80">{aiErrorMessage(list.error)}</p>
            <Button type="button" size="xs" variant="outline" className="mt-2" onClick={() => list.refetch()}>Retry</Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"><MessageSquare className="size-4" /></span>
            <p className="text-sm font-medium text-foreground">{needle ? "No matching chats" : tab === "archived" ? "No archived chats" : "No conversations yet"}</p>
            <p className="text-xs text-muted-foreground">{needle ? "Only loaded chats are searched. Load more to widen the search." : tab === "archived" ? "Archived chats appear here and can be restored." : "Start a new chat to ask about your documents."}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {visible.map((c) => {
              const active = c.id === selectedId;
              return (
                <li key={c.id} className="group/item relative">
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn("flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 pr-9 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-primary/10 text-foreground" : "text-foreground/90 hover:bg-muted")}
                  >
                    <span className="w-full truncate text-sm font-medium">{c.title}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {c.busy ? "Answering…" : `${formatDistanceToNowStrict(new Date(c.lastActivityAt), { addSuffix: true })}${c.messageCount ? ` · ${c.messageCount} messages` : ""}`}
                    </span>
                  </button>
                  <ConversationActionsMenu
                    conversation={c}
                    onRename={onRename}
                    onArchive={onArchive}
                    onDelete={onDelete}
                    className="absolute right-1 top-1.5 opacity-100 md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100 data-[state=open]:opacity-100"
                  />
                </li>
              );
            })}
          </ul>
        )}

        {list.hasNextPage ? (
          <div className="p-2">
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </nav>
    </div>
  );
}
