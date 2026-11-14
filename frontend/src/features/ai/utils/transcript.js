/**
 * Pure helpers for what the transcript shows while a turn is live.
 *
 * While a turn is in flight the live overlay IS that turn. Whatever the server has already saved for it (a refetch can land
 * mid-stream, and a brand-new conversation always fetches) must not be shown as well, and above all must not replace the live
 * text with an empty saved copy. Saved messages are hidden by sequence number: anything newer than what existed when the
 * message was sent belongs to the live turn.
 */
export function visibleMessages(messages, pending) {
  if (!pending) return messages;
  return messages.filter((m) => m.seq <= pending.baseSeq);
}

/** True while the newest saved assistant message is still being generated on the server (first page = newest). */
export function hasStreamingReply(data) {
  const newest = data?.pages?.[0]?.messages;
  const last = newest?.[newest.length - 1];
  return Boolean(last && last.role === "assistant" && last.status === "streaming");
}
