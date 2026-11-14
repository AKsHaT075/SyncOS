"use client";

import { AlertCircle, ArchiveRestore, Info, Loader2, Menu, MessageSquareOff, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import Composer from "@/features/ai/components/Composer";
import ConversationActionsMenu from "@/features/ai/components/ConversationActionsMenu";
import MessageList from "@/features/ai/components/MessageList";
import { flattenMessages } from "@/features/ai/hooks/aiHooks";
import { UNAVAILABLE_REASONS } from "@/features/ai/utils/errors";
import { aiErrorMessage } from "@/features/ai/utils/apiError";

const SUGGESTIONS = ["What is our leave policy?", "How do expense claims work?", "What is the notice period for resignation?"];

function Centered({ children }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">{children}</div>;
}

function Welcome({ onPick, disabled }) {
  return (
    <Centered>
      <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-6" /></span>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">Ask about your company&apos;s documents</h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Sync Copilot answers from documents you can already access and shows its sources. If it cannot find an answer, it says so. English only for now.
        </p>
      </div>
      <div className="mt-2 flex max-w-xl flex-wrap justify-center gap-2" aria-label="Example questions">
        {SUGGESTIONS.map((s) => (
          <Button key={s} type="button" variant="outline" size="sm" className="rounded-full" disabled={disabled} onClick={() => onPick(s)}>{s}</Button>
        ))}
      </div>
    </Centered>
  );
}

function MessagesSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6" aria-busy="true" aria-label="Loading messages">
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <div className="flex gap-3"><Skeleton className="size-7 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-3/5" /><Skeleton className="h-4 w-2/3" /></div></div>
    </div>
  );
}

export default function ChatWorkspace({ selectedId, conversation, messages, session, draft, setDraft, status, onOpenSidebar, onNew, onRename, onArchive, onDelete }) {
  const list = flattenMessages(messages.data);
  const unavailable = status.data && !status.data.ready ? UNAVAILABLE_REASONS[status.data.reason] || "AI is not available right now." : null;
  const archived = conversation.data?.status === "archived";
  const busyElsewhere = conversation.data?.busy && !session.isBusy;
  const goneForUser = selectedId && conversation.isError;
  const notFound = goneForUser && conversation.error?.response?.status === 404;

  let body;
  if (goneForUser) {
    body = notFound ? (
      <Centered>
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><MessageSquareOff className="size-5" /></span>
        <h2 className="text-base font-semibold text-foreground">Conversation not available</h2>
        <p className="max-w-sm text-sm text-muted-foreground">It may have been deleted, or it is not one of your conversations.</p>
        <Button type="button" onClick={onNew}>Start a new chat</Button>
      </Centered>
    ) : (
      <Centered>
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-sm text-foreground">Could not open this conversation</p>
        <p className="text-xs text-muted-foreground">{aiErrorMessage(conversation.error)}</p>
        <Button type="button" variant="outline" onClick={() => conversation.refetch()}>Retry</Button>
      </Centered>
    );
  } else if (!selectedId && !session.isBusy) {
    body = <Welcome onPick={setDraft} disabled={Boolean(unavailable)} />;
  } else if (selectedId && (conversation.isLoading || messages.isLoading) && !session.isBusy) {
    body = <MessagesSkeleton />;
  } else if (selectedId && messages.isError && !session.isBusy) {
    body = (
      <Centered>
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-sm text-foreground">Could not load messages</p>
        <p className="text-xs text-muted-foreground">{aiErrorMessage(messages.error)}</p>
        <Button type="button" variant="outline" onClick={() => messages.refetch()}>Retry</Button>
      </Centered>
    );
  } else if (selectedId && list.length === 0 && !session.isBusy) {
    body = <Welcome onPick={setDraft} disabled={Boolean(unavailable) || archived} />;
  } else {
    body = (
      <MessageList
        messages={list}
        pending={session.pending}
        hasOlder={Boolean(messages.hasNextPage)}
        loadingOlder={messages.isFetchingNextPage}
        onLoadOlder={() => messages.fetchNextPage()}
        onAskAgain={setDraft}
      />
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
        <Button type="button" variant="ghost" size="icon-sm" className="xl:hidden" onClick={onOpenSidebar} aria-label="Open conversations"><Menu /></Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{selectedId && conversation.data ? conversation.data.title : "Sync Copilot"}</h1>
        {archived ? <Badge variant="secondary">Archived</Badge> : null}
        {selectedId && conversation.data ? <ConversationActionsMenu conversation={conversation.data} onRename={onRename} onArchive={onArchive} onDelete={onDelete} /> : null}
      </header>

      {unavailable ? (
        <div role="status" className="flex items-start gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>{unavailable} You can still read and manage your existing conversations.</span>
        </div>
      ) : null}
      {busyElsewhere ? (
        <div role="status" className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          This conversation is still finishing a reply. New messages are paused until it ends.
        </div>
      ) : null}

      {body}
      <p className="sr-only" aria-live="polite">{session.isBusy ? "The assistant is responding." : ""}</p>

      {archived ? (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <span>This conversation is archived. Restore it to continue.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => onArchive(conversation.data, false)}><ArchiveRestore />Restore</Button>
        </div>
      ) : goneForUser ? null : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => {
            const text = draft;
            setDraft("");
            session.send(text, { baseSeq: list.at(-1)?.seq ?? 0 });
          }}
          onStop={session.stop}
          busy={session.isBusy}
          disabled={Boolean(unavailable) || Boolean(busyElsewhere)}
          disabledReason={unavailable ? "Sending is unavailable right now." : null}
          autoFocusKey={selectedId || "new"}
        />
      )}
    </section>
  );
}
