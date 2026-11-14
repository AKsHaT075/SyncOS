import { normalizeCitations } from "./citations.js";
import { parseToolActivity } from "./toolActivity.js";

/**
 * Pure state transitions for the live part of a turn (`pending` in useChatSession). Kept free of React so every rule is testable.
 *
 * pending.activity is the fixed description of the lookup in progress (or null). It exists ONLY between a valid `tool_activity` event
 * and the first answer text / done / error / Stop; it is never part of the reply text and never saved.
 */
export function newPending({ baseSeq = 0, userText }) {
  return { baseSeq, userText, assistantText: "", citations: [], sourcesUsed: null, phase: "sending", finishReason: null, userMessageId: null, assistantMessageId: null, activity: null };
}

/** Returns the next `pending` for one server event (the same object when the event changes nothing). Side effects stay in the hook. */
export function applyStreamEvent(pending, event, data) {
  if (!pending) return pending;
  switch (event) {
    case "meta":
      return { ...pending, userMessageId: data?.userMessageId ?? null, assistantMessageId: data?.assistantMessageId ?? null };
    case "retrieval":
      return { ...pending, sourcesUsed: data?.sourcesUsed };
    case "tool_activity": {
      const activity = parseToolActivity(event, data);
      // Ignored: anything malformed or unknown; and anything after the answer began or Stop was pressed (the indicator is already gone).
      if (!activity || pending.assistantText || pending.phase === "stopping") return pending;
      return pending.activity === activity.label ? pending : { ...pending, activity: activity.label };
    }
    case "text":
      return { ...pending, phase: pending.phase === "stopping" ? "stopping" : "streaming", assistantText: pending.assistantText + (data?.text || ""), activity: null };
    case "citations":
      return { ...pending, citations: normalizeCitations(data?.citations) };
    case "done":
      return { ...pending, finishReason: data?.finishReason, phase: "streaming", activity: null };
    case "error":
      return pending.activity ? { ...pending, activity: null } : pending;
    default:
      return pending; // an unknown event is ignored: it can never reach the screen
  }
}

/** Stop pressed: the indicator goes at once, before the connection finishes closing. */
export function markStopping(pending) {
  return pending ? { ...pending, phase: "stopping", activity: null } : pending;
}

/**
 * Identifies the CURRENT request. Every send takes a token; switching conversations, unmounting or starting another send invalidates
 * the old one, so a late event of an aborted request (already read from the network, not yet handled) cannot touch what is on screen.
 */
export function createRequestGuard() {
  let current = 0;
  return {
    begin: () => (current += 1),
    invalidate: () => { current += 1; },
    isCurrent: (token) => token === current,
  };
}
