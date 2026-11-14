"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import ConfirmDialog from "@/features/documents/components/ConfirmDialog";
import NameDialog from "@/features/documents/components/NameDialog";
import ChatWorkspace from "@/features/ai/components/ChatWorkspace";
import ConversationSidebar from "@/features/ai/components/ConversationSidebar";
import { useAiStatus, useArchiveConversation, useConversation, useDeleteConversation, useMessages, useRenameConversation } from "@/features/ai/hooks/aiHooks";
import { useChatSession } from "@/features/ai/hooks/useChatSession";
import { conversationTitleSchema } from "@/features/ai/schemas/aiSchemas";

const ID = /^[a-f0-9]{24}$/i;

/**
 * AI Studio. The open conversation is in the URL (?c=<id>), so a refresh restores it from the server and back/forward work.
 * Everything shown comes from the conversation API; nothing is stored in the browser.
 */
export default function AiStudio() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const param = searchParams.get("c");
  const selectedId = param && ID.test(param) ? param : null; // a malformed id never reaches the API

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const status = useAiStatus();
  const conversation = useConversation(selectedId);
  const messages = useMessages(selectedId);

  const open = useCallback((id) => router.push(id ? `${pathname}?c=${id}` : pathname), [pathname, router]);
  const onCreated = useCallback((id) => router.replace(`${pathname}?c=${id}`), [pathname, router]);
  const onGone = useCallback(() => router.replace(pathname), [pathname, router]);
  const restoreDraft = useCallback((text) => setDraft((current) => current || text), []);

  const session = useChatSession({ conversationId: selectedId, onConversationCreated: onCreated, onRestoreDraft: restoreDraft, onGone });

  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation({ onDeleted: (id) => { if (id === selectedId) router.replace(pathname); } });

  const select = (id) => { setSidebarOpen(false); open(id); };
  const startNew = () => { setSidebarOpen(false); setDraft(""); open(null); };

  const renderSidebar = (inSheet) => (
    <ConversationSidebar
      inSheet={inSheet}
      selectedId={selectedId}
      onSelect={select}
      onNew={startNew}
      onRename={setRenameTarget}
      onArchive={(c, archived) => archive.mutate({ id: c.id, archived })}
      onDelete={setDeleteTarget}
    />
  );

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 border-r border-border xl:block xl:w-80" aria-label="Conversation history">{renderSidebar(false)}</aside>

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-sm gap-0 p-0 xl:hidden" showCloseButton>
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">Your AI conversations</SheetDescription>
          {renderSidebar(true)}
        </SheetContent>
      </Sheet>

      <ChatWorkspace
        selectedId={selectedId}
        conversation={conversation}
        messages={messages}
        session={session}
        draft={draft}
        setDraft={setDraft}
        status={status}
        onOpenSidebar={() => setSidebarOpen(true)}
        onNew={startNew}
        onRename={setRenameTarget}
        onArchive={(c, archived) => archive.mutate({ id: c.id, archived })}
        onDelete={setDeleteTarget}
      />

      <NameDialog
        open={Boolean(renameTarget)}
        onOpenChange={(next) => !next && setRenameTarget(null)}
        title="Rename conversation"
        label="Title"
        initialValue={renameTarget?.title ?? ""}
        submitLabel="Rename"
        schema={conversationTitleSchema}
        isPending={rename.isPending}
        onSubmit={(title) => rename.mutateAsync({ id: renameTarget.id, title })}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        title="Delete this conversation?"
        description="The conversation and all of its messages are permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        destructive
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ id: deleteTarget.id }, { onSettled: () => setDeleteTarget(null) })}
      />
    </div>
  );
}
