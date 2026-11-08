"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useDismissNotification, useMarkAllRead, useMarkRead } from "@/features/notifications/hooks/notificationHooks";

/** Shared click behaviour for the popover and the full page. */
export function useNotificationActions({ onNavigate } = {}) {
  const router = useRouter();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const dismiss = useDismissNotification();

  const open = useCallback(
    (notification) => {
      if (!notification.read) markRead.mutate(notification.id);
      // The server only sends a link while the user may access the destination.
      if (notification.link) {
        onNavigate?.();
        router.push(notification.link);
      }
    },
    [markRead, router, onNavigate],
  );

  return {
    open,
    markRead: useCallback((notification) => markRead.mutate(notification.id), [markRead]),
    markAllRead: useCallback((category) => markAllRead.mutate(category), [markAllRead]),
    dismiss: useCallback((notification) => dismiss.mutate(notification.id), [dismiss]),
    isMarkingAll: markAllRead.isPending,
  };
}
