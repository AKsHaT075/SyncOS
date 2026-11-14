/** Friendly, honest messages for the backend's error codes. Never shows raw server text for 5xx. */
const BY_CODE = {
  CONVERSATION_BUSY: "This conversation is still answering. Wait for the reply to finish or stop it first.",
  CONVERSATION_ARCHIVED: "This conversation is archived. Restore it to continue.",
  CONVERSATION_FULL: "This conversation has reached its length limit. Start a new conversation.",
  CONVERSATION_LIMIT: "You have reached the maximum number of conversations. Delete some to continue.",
  CONVERSATION_NOT_FOUND: "This conversation is no longer available.",
  AI_KNOWLEDGE_NOT_READY: "The document search index is not ready yet. Please try again later.",
  AI_RETRIEVAL_UNAVAILABLE: "Searching your documents is temporarily unavailable. Please try again.",
  AI_DISABLED: "AI is not enabled for your organization.",
  AI_NOT_CONFIGURED: "AI is not available right now.",
  AI_RATE_LIMITED: "You are sending requests too quickly. Please wait a moment.",
  AI_REQUEST_ABORTED: "The reply was stopped.",
};

export function describeAiError({ status, code, message } = {}) {
  if (BY_CODE[code]) return BY_CODE[code];
  if (code && String(code).startsWith("AI_QUOTA")) return "Your AI usage limit has been reached. Try again later.";
  if (status === 429) return "Too many requests. Please wait and try again.";
  if (status === 401) return "Your session expired. Please sign in again.";
  if (status === 403) return "You do not have permission to use AI Studio.";
  if (status === 404) return BY_CODE.CONVERSATION_NOT_FOUND;
  if (status >= 500 || !status) return "Something went wrong while generating the reply. Please try again.";
  return typeof message === "string" && message ? message : "The request could not be completed.";
}

/** Reasons from GET /ai/status when AI is not ready. */
export const UNAVAILABLE_REASONS = {
  NO_ACCESS: "Your role does not include AI access.",
  PLATFORM_DISABLED: "AI is turned off for the platform.",
  NOT_CONFIGURED: "AI is not configured yet.",
  ORG_DISABLED: "AI is not enabled for your organization. An administrator can turn it on in AI settings.",
};
