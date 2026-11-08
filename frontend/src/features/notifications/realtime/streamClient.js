import { api } from "@/lib/axios";
import { useAuthStore } from "@/store/useAuthStore";
import { notificationService } from "@/features/notifications/services/notificationService";

const LOCK_NAME = "syncos-notifications-stream";
const CHANNEL_NAME = "syncos-notifications";
// The server closed the stream because the user lost access: never reconnect on our own.
const FATAL_REASONS = new Set(["blocked", "removed", "sessions_revoked"]);

/**
 * Minimal Server-Sent-Events reader on top of fetch().
 *
 * Why not EventSource: it can only authenticate with cookies (the rest of the
 * app also sends the Bearer token) and it hides the HTTP status, so a 401, a
 * 403 "blocked" and a network blip all look the same. fetch() lets us send the
 * Authorization header and react to the exact status.
 */
async function readEventStream(url, { token, signal, onOpen, onEvent }) {
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    credentials: "include",
    cache: "no-store",
    signal,
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    return { status: response.status, code: body?.code };
  }

  onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    blocks.forEach((block) => {
      let event = "message";
      const dataLines = [];
      block.split(/\r?\n/).forEach((line) => {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        // ": ping" heartbeats and "retry:" hints are comments/fields we ignore.
      });
      if (dataLines.length === 0) return;
      try {
        onEvent(event, JSON.parse(dataLines.join("\n")));
      } catch {
        /* malformed event: skip it */
      }
    });
  }
  return { status: 200, ended: true };
}

/**
 * One live connection per browser, shared by every open tab.
 *
 *  - Browsers cap connections per site, so tabs elect a leader with the Web
 *    Locks API: the tab holding the lock owns the stream and relays each event
 *    to the others over a BroadcastChannel. If the leader closes, the lock
 *    passes to another tab, which connects and resyncs from the server. Without
 *    Locks/BroadcastChannel support each tab simply connects itself.
 *  - The access token expires and the server ends the stream when it does. On
 *    any interruption we first make one authenticated API call (the axios
 *    interceptor refreshes the token), then reconnect with exponential backoff
 *    and jitter.
 *  - Missed events are never replayed: every (re)connect starts with a `ready`
 *    event and the cache resyncs from the server (MongoDB is the source of truth).
 *
 * `onEvent({event, data})` is called for every event, whether it came from our
 * own stream or another tab's broadcast.
 */
export function startNotificationStream({ onEvent, onFatal }) {
  let stopped = false;
  let controller = null;
  let timer = null;
  let attempts = 0;
  let releaseLock = null;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (channel) {
    channel.onmessage = (message) => onEvent(message.data);
  }

  const emit = (payload) => {
    onEvent(payload);
    try {
      channel?.postMessage(payload);
    } catch {
      /* channel closed */
    }
  };

  const abort = () => {
    controller?.abort();
    controller = null;
  };

  const scheduleReconnect = ({ refreshAuth, minDelay = 0 }) => {
    if (stopped) return;
    abort();
    clearTimeout(timer);
    const backoff = Math.min(30_000, 1000 * 2 ** attempts);
    attempts += 1;
    const delay = Math.max(minDelay, backoff) + Math.floor(Math.random() * 500);

    timer = setTimeout(async () => {
      if (stopped) return;
      if (refreshAuth) {
        try {
          await api.get("/notifications/unread-count"); // a 401 here makes the interceptor refresh the token
        } catch (error) {
          if (error?.response?.status === 403 && error.response.data?.code === "ORG_BLOCKED") {
            stopped = true;
            onFatal?.("blocked");
            return;
          }
          if (error?.response?.status === 401) return; // refresh failed: the interceptor signs the user out
          // Network error: fall through and try the stream anyway.
        }
      }
      connect();
    }, delay);
  };

  async function connect() {
    if (stopped) return;
    abort();
    const current = new AbortController();
    controller = current;
    let closeReason = null;

    try {
      const result = await readEventStream(notificationService.streamUrl(), {
        token: useAuthStore.getState().accessToken,
        signal: current.signal,
        onOpen: () => {
          attempts = 0;
        },
        onEvent: (event, data) => {
          if (event !== "close") {
            emit({ event, data });
            return;
          }
          closeReason = data.reason || "closed";
          current.abort(); // the server is about to end the stream anyway
        },
      });

      if (stopped || current.signal.aborted) throw new DOMException("aborted", "AbortError");

      if (result.status === 401) return scheduleReconnect({ refreshAuth: true });
      if (result.status === 403) {
        stopped = true;
        return onFatal?.(result.code === "ORG_BLOCKED" ? "blocked" : "forbidden");
      }
      // Stream ended without a close event (proxy timeout, deploy…) or the server errored: retry.
      return scheduleReconnect({ refreshAuth: result.status === 200 });
    } catch (error) {
      if (stopped) return undefined;
      if (error?.name === "AbortError" && closeReason) {
        if (FATAL_REASONS.has(closeReason)) {
          stopped = true;
          return onFatal?.(closeReason);
        }
        // token_expired / server_shutdown: reconnect (re-auth first on expiry).
        // replaced: another tab pushed us out — wait longer so two tabs never ping-pong.
        return scheduleReconnect({ refreshAuth: closeReason === "token_expired", minDelay: closeReason === "replaced" ? 5000 : 0 });
      }
      if (error?.name === "AbortError") return undefined;
      return scheduleReconnect({ refreshAuth: false }); // network error
    }
  }

  if (channel && typeof navigator !== "undefined" && navigator.locks) {
    // Resolves (and we become the leader) once no other tab holds the lock.
    navigator.locks
      .request(LOCK_NAME, () => new Promise((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        releaseLock = resolve;
        connect();
      }))
      .catch(() => {
        if (!stopped) connect();
      });
  } else {
    connect();
  }

  return function stop() {
    stopped = true;
    clearTimeout(timer);
    abort();
    releaseLock?.(); // hands leadership to another tab
    channel?.close();
  };
}
