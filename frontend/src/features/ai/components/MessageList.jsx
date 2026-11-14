"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import MessageBubble from "@/features/ai/components/MessageBubble";
import { visibleMessages } from "@/features/ai/utils/transcript";

const NEAR_BOTTOM_PX = 96;

/**
 * Scrolling transcript. Stays pinned to the newest text while a reply streams - unless the user scrolled up to read, in which case
 * a "Jump to latest" button appears instead of yanking them down. Older pages load on demand and keep the reading position.
 */
export default function MessageList({ messages, pending, hasOlder, loadingOlder, onLoadOlder, onAskAgain }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [highlight, setHighlight] = useState(null); // { messageId, n }
  const prependAnchor = useRef(null);
  const prevHeight = useRef(0); // scrollHeight before the latest content change: tells whether the reader WAS at the bottom

  const scrollToBottom = useCallback((behavior = "auto") => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = near;
    setAway(!near);
  };

  // Follow new content only if the reader was at the bottom BEFORE it arrived. This reads the real scroll position at update time
  // (not just the last scroll event), so a reader who has just scrolled up is never pulled back down mid-stream.
  const tail = pending?.assistantText?.length ?? 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!prependAnchor.current) {
      const wasAtBottom = prevHeight.current - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (stick.current && wasAtBottom) scrollToBottom();
    }
    prevHeight.current = el.scrollHeight;
  }, [messages.length, tail, pending?.phase, pending?.userText, pending?.activity, scrollToBottom]);

  // Prepending older messages must not move what the user is reading.
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight - anchor;
      prependAnchor.current = null;
      prevHeight.current = scroller.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    stick.current = true;
    scrollToBottom();
    prevHeight.current = scroller.current?.scrollHeight ?? 0;
  }, [scrollToBottom]);

  const loadOlder = () => {
    prependAnchor.current = scroller.current.scrollHeight - scroller.current.scrollTop;
    onLoadOlder();
  };

  const jumpToSource = (messageId, n) => {
    const el = document.getElementById(`cite-${messageId}-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlight({ messageId, n });
    setTimeout(() => setHighlight((h) => (h && h.messageId === messageId && h.n === n ? null : h)), 2200);
  };

  // While a turn is live, the overlay IS that turn. Anything the server already saved for it (a refetch can land mid-stream, and a
  // new conversation always fetches) is hidden by sequence number, so the live text is never replaced by an empty saved copy and
  // nothing is shown twice. When the turn ends the overlay is dropped and the saved messages take over.
  const shown = visibleMessages(messages, pending);
  const showOverlay = Boolean(pending);
  const lastUserBefore = (index) => {
    for (let i = index - 1; i >= 0; i -= 1) if (shown[i].role === "user") return shown[i].content;
    return null;
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} onWheel={(event) => { if (event.deltaY < 0) stick.current = false; }} role="log" aria-label="Conversation" aria-busy={Boolean(pending)} className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {hasOlder ? (
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? <Loader2 className="animate-spin" /> : null}
                Load earlier messages
              </Button>
            </div>
          ) : null}

          {shown.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              previousUserText={message.role === "assistant" ? lastUserBefore(index) : null}
              onAskAgain={onAskAgain}
              onCite={jumpToSource}
              highlighted={highlight?.messageId === message.id ? highlight.n : null}
            />
          ))}

          {showOverlay ? (
            <>
              <MessageBubble message={{ id: "pending-user", role: "user", content: pending.userText }} />
              <MessageBubble
                message={{ id: pending.assistantMessageId || "pending-assistant", role: "assistant", content: pending.assistantText, status: "streaming", citations: pending.citations }}
                live
                phase={pending.phase}
                activity={pending.activity}
                sourcesUsed={pending.sourcesUsed}
                onCite={jumpToSource}
                highlighted={highlight?.messageId === (pending.assistantMessageId || "pending-assistant") ? highlight.n : null}
              />
            </>
          ) : null}
        </div>
      </div>

      {away ? (
        <Button type="button" size="sm" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md" onClick={() => { stick.current = true; scrollToBottom("smooth"); }}>
          <ArrowDown />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
