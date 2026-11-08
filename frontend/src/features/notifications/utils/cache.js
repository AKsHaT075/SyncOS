import { UNREAD_CAP } from "@/features/notifications/constants/notificationOptions";

export const KEYS = {
  all: ["notifications"],
  lists: ["notifications", "list"],
  unread: ["notifications", "unread"],
  preferences: ["notifications", "preferences"],
};

/**
 * Cache synchronisation. The server (MongoDB) is the source of truth; the
 * cache is patched by live events and by optimistic mutations, and the helpers
 * below are idempotent — the same event may arrive twice (own mutation + SSE,
 * or via the cross-tab broadcast) without corrupting anything.
 */

function mapPages(data, fn) {
  return { ...data, pages: data.pages.map((page) => ({ ...page, notifications: fn(page.notifications) })) };
}

function patchLists(queryClient, patch) {
  queryClient.getQueriesData({ queryKey: KEYS.lists }).forEach(([key, data]) => {
    if (!data?.pages) return;
    const filters = key[2] || {};
    const next = patch(data, filters);
    if (next !== data) queryClient.setQueryData(key, next);
  });
}

export function setUnreadCount(queryClient, count) {
  if (typeof count !== "number") return;
  queryClient.setQueryData(KEYS.unread, { count, capped: count >= UNREAD_CAP });
}

export function findInCache(queryClient, id) {
  for (const [, data] of queryClient.getQueriesData({ queryKey: KEYS.lists })) {
    for (const page of data?.pages ?? []) {
      const found = page.notifications.find((item) => item.id === id);
      if (found) return found;
    }
  }
  return null;
}

export function insertNotification(queryClient, notification) {
  patchLists(queryClient, (data, filters) => {
    if (filters.category && filters.category !== notification.category) return data;
    if (data.pages.some((page) => page.notifications.some((item) => item.id === notification.id))) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, notifications: [notification, ...first.notifications] }, ...rest] };
  });
}

export function markReadInCache(queryClient, id) {
  patchLists(queryClient, (data, filters) =>
    mapPages(data, (items) =>
      filters.status === "unread"
        ? items.filter((item) => item.id !== id)
        : items.map((item) => (item.id === id && !item.read ? { ...item, read: true, readAt: new Date().toISOString() } : item)),
    ));
}

export function markAllReadInCache(queryClient, category) {
  patchLists(queryClient, (data, filters) =>
    mapPages(data, (items) => {
      const matches = (item) => !category || item.category === category;
      if (filters.status === "unread") return items.filter((item) => !matches(item));
      return items.map((item) => (matches(item) && !item.read ? { ...item, read: true, readAt: new Date().toISOString() } : item));
    }));
}

export function removeFromCache(queryClient, id) {
  patchLists(queryClient, (data) => mapPages(data, (items) => items.filter((item) => item.id !== id)));
}

/** Applies a server-sent event (from this tab's stream or another tab's broadcast). */
export function applyEvent(queryClient, { event, data }) {
  switch (event) {
    case "ready":
      // (Re)connected: anything could have happened while we were away — resync from the server.
      setUnreadCount(queryClient, data?.unreadCount);
      queryClient.invalidateQueries({ queryKey: KEYS.lists });
      return;
    case "notification.created":
      insertNotification(queryClient, data.notification);
      setUnreadCount(queryClient, data.unreadCount);
      return;
    case "notification.read":
      markReadInCache(queryClient, data.id);
      setUnreadCount(queryClient, data.unreadCount);
      return;
    case "notification.read_all":
      markAllReadInCache(queryClient, data.category);
      setUnreadCount(queryClient, data.unreadCount);
      return;
    case "notification.dismissed":
      removeFromCache(queryClient, data.id);
      setUnreadCount(queryClient, data.unreadCount);
      return;
    default:
  }
}
