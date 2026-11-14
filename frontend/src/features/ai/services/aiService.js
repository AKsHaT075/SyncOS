import { api } from "@/lib/axios";
import { useAuthStore } from "@/store/useAuthStore";
import { createSseParser } from "@/features/ai/utils/sse";

const base = "/ai";
const csrfCookieName = process.env.NEXT_PUBLIC_CSRF_COOKIE_NAME || "sync_csrf_token";

export class AiRequestError extends Error {
  constructor({ status, code, message }) {
    super(message || "AI request failed");
    this.name = "AiRequestError";
    this.status = status;
    this.code = code;
  }
}

function readCookie(name) {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Conversations live ONLY on the server (MongoDB). Nothing here is cached in localStorage / sessionStorage.
export const aiService = {
  status: async () => (await api.get(`${base}/status`)).data,
  listConversations: async (params) => (await api.get(`${base}/conversations`, { params })).data,
  createConversation: async (payload = {}) => (await api.post(`${base}/conversations`, payload)).data,
  getConversation: async (id) => (await api.get(`${base}/conversations/${id}`)).data,
  updateConversation: async (id, updates) => (await api.patch(`${base}/conversations/${id}`, updates)).data,
  deleteConversation: async (id) => (await api.delete(`${base}/conversations/${id}`)).data,
  listMessages: async (id, params) => (await api.get(`${base}/conversations/${id}/messages`, { params })).data,
};

function openStream(id, content, signal) {
  const token = useAuthStore.getState().accessToken;
  const csrf = readCookie(csrfCookieName);
  return fetch(`${api.defaults.baseURL}${base}/conversations/${id}/messages`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: JSON.stringify({ content }),
  });
}

/**
 * Sends one message and reads the reply as Server-Sent Events (fetch, not EventSource: the app authenticates with a Bearer token
 * and needs the real HTTP status). Calls `onEvent(name, data)` for every event.
 *
 * Errors that happen BEFORE the stream starts (validation, 404, 409 busy/archived, quota, ...) throw AiRequestError and nothing was
 * saved by the server. Network failures throw as-is; an abort throws AbortError.
 * Resolves `{ complete }`: whether a terminal `done`/`error` event was seen (false = the connection ended early).
 */
export async function streamMessage({ conversationId, content, signal, onEvent }) {
  let response = await openStream(conversationId, content, signal);
  if (response.status === 401) {
    await api.get(`${base}/status`); // the axios interceptor refreshes the access token; then we retry exactly once
    response = await openStream(conversationId, content, signal);
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new AiRequestError({ status: response.status, code: body?.code, message: body?.message });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const { event, data } of parser.push(decoder.decode(value, { stream: true }))) {
        if (event === "done" || event === "error") complete = true;
        onEvent(event, data);
      }
    }
  } finally {
    reader.cancel().catch(() => {}); // on every exit (end, abort, network error, handler error) release the connection
  }
  return { complete };
}
