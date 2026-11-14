"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AI_KEY } from "@/features/ai/hooks/aiHooks";
import { AiRequestError, aiService, streamMessage } from "@/features/ai/services/aiService";
import { describeAiError } from "@/features/ai/utils/errors";
import { aiErrorMessage } from "@/features/ai/utils/apiError";
import { applyStreamEvent, createRequestGuard, markStopping, newPending } from "@/features/ai/utils/liveTurn";

/**
 * The live part of a conversation turn. The server is the source of truth: this hook only shows what is arriving (`pending`),
 * and once the turn is over it re-reads the saved messages and drops the overlay. Nothing is persisted in the browser.
 *
 * pending: { baseSeq (highest saved seq when the send started), userText, assistantText, citations, sourcesUsed, phase, userMessageId, assistantMessageId, finishReason, activity }
 *   activity: the fixed description of a live lookup ("Checking your tasks") or null; see utils/liveTurn.js and utils/toolActivity.js
 *   phase: "sending" (request sent, nothing yet) | "streaming" | "stopping"
 *
 * Guarantees
 *  - one submission at a time (a ref lock, not just a disabled button), so double-clicks / Enter-Enter cannot duplicate a message
 *  - Stop aborts the request; the server keeps the partial reply as "incomplete"
 *  - a dropped connection is reported, then the saved state is re-read (the server also treats a closed connection as a cancel)
 *  - a failure BEFORE the reply starts saved nothing, so the user's text is handed back to the composer
 */
export function useChatSession({ conversationId, onConversationCreated, onRestoreDraft, onGone }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(null);
  const lock = useRef(false);
  const controllerRef = useRef(null);
  const ownedId = useRef(null); // a conversation this hook just created: switching the URL to it must not cancel the stream
  const mounted = useRef(true);
  const guard = useRef(createRequestGuard()); // which request may still update the screen

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      guard.current.invalidate();
      controllerRef.current?.abort();
    };
  }, []);

  // Leaving a conversation while a reply is streaming stops it (the server saves what exists).
  useEffect(() => {
    if (conversationId && conversationId === ownedId.current) return;
    guard.current.invalidate(); // events of the request being left can no longer update this screen
    if (controllerRef.current) {
      controllerRef.current.abort();
      toast.message("Reply stopped because you switched conversations.");
    }
    setPending(null);
  }, [conversationId]);

  const resync = useCallback(
    async (id) => {
      // Re-read what the server saved, then (and only then) drop the overlay: no flash, no duplicate bubbles.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [AI_KEY, "messages", id] }),
        queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversations"] }),
        queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversation", id] }),
      ]).catch(() => {});
    },
    [queryClient],
  );

  const send = useCallback(
    async (rawText, { baseSeq = 0 } = {}) => {
      const text = rawText.trim();
      if (!text || lock.current) return false;
      lock.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      const token = guard.current.begin();
      setPending(newPending({ baseSeq, userText: text }));

      let id = conversationId;
      let streamStarted = false;
      let interrupted = false;
      let refused = false;
      let createdHere = false;
      try {
        try {
          if (!id) {
            const created = (await aiService.createConversation()).conversation;
            id = created.id;
            ownedId.current = id;
            createdHere = true;
            queryClient.setQueryData([AI_KEY, "conversation", id], created);
            onConversationCreated?.(id);
          }

          const { complete } = await streamMessage({
            conversationId: id,
            content: text,
            signal: controller.signal,
            onEvent: (event, data) => {
              if (!guard.current.isCurrent(token) || controller.signal.aborted) return; // a late event of a stopped / left request
              if (event === "text") streamStarted = true;
              setPending((p) => applyStreamEvent(p, event, data));
              if (event === "meta") {
                // The server named the conversation from the question when it accepted the turn: show that title now, not at the end.
                queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversation", id] });
                queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversations"] });
              } else if (event === "error") toast.error(describeAiError({ code: data.code, status: 502 })); // the saved message also shows the failure
            },
          });
          interrupted = !complete;
        } catch (error) {
          if (error?.name === "AbortError") {
            /* the user pressed Stop (or left): the server saved the partial reply */
          } else if (error instanceof AiRequestError || error?.response) {
            // Refused before anything was saved (AiRequestError: the stream request; error.response: creating the conversation).
            refused = true;
            toast.error(error instanceof AiRequestError ? describeAiError(error) : aiErrorMessage(error));
            onRestoreDraft?.(text);
            controllerRef.current = null; // the leave-conversation effect must not treat the redirect below as the user switching away
            if (createdHere && id) {
              // The very first message of a brand-new chat was refused: nothing was saved, so do not leave an empty conversation behind.
              ownedId.current = null;
              aiService.deleteConversation(id).catch(() => {});
              queryClient.removeQueries({ queryKey: [AI_KEY, "conversation", id] });
              queryClient.removeQueries({ queryKey: [AI_KEY, "messages", id] });
              queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversations"] });
              onGone?.(id);
            } else if (error.status === 404 && id) onGone?.(id);
            if (id && (error.code === "CONVERSATION_BUSY" || error.code === "CONVERSATION_ARCHIVED")) queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversation", id] });
          } else {
            interrupted = true; // network failure
          }
        }

        if (refused) {
          setPending(null);
          return false;
        }
        if (interrupted && mounted.current) {
          toast.warning("Connection lost. The reply may be incomplete; showing what was saved.");
          if (!streamStarted) onRestoreDraft?.(text);
        }
        if (id) await resync(id);
        if (mounted.current) setPending(null);
        return true;
      } finally {
        lock.current = false; // released on EVERY exit path, including an unexpected throw
        controllerRef.current = null;
      }
    },
    [conversationId, onConversationCreated, onRestoreDraft, onGone, queryClient, resync],
  );

  const stop = useCallback(() => {
    if (!controllerRef.current) return;
    setPending(markStopping);
    controllerRef.current.abort();
  }, []);

  return { pending, isBusy: Boolean(pending), send, stop };
}
