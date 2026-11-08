"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "@/store/useAuthStore";
import { startNotificationStream } from "@/features/notifications/realtime/streamClient";
import { KEYS, applyEvent } from "@/features/notifications/utils/cache";

/**
 * Mounts the live notification connection for the signed-in, non-blocked user
 * and keeps the TanStack Query cache in sync. Renders nothing.
 */
export default function NotificationRealtime() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const hasOrganization = useAuthStore((state) => Boolean(state.organization));
  const orgBlocked = useAuthStore((state) => Boolean(state.user?.orgBlocked));
  const enabled = isAuthenticated && hasOrganization && !orgBlocked && Boolean(userId);

  // The handler reads the latest route without restarting the connection.
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!enabled) return undefined;

    const stop = startNotificationStream({
      onEvent: (payload) => {
        applyEvent(queryClient, payload);
        // A calendar invitation / change / cancellation means the calendar view is out of date.
        if (payload.event === "notification.created" && payload.data?.notification?.category === "calendar") {
          queryClient.invalidateQueries({ queryKey: ["calendar"] });
        }

        // Pop a toast only in the tab the user is looking at, and not while they're reading the inbox.
        if (
          payload.event === "notification.created" &&
          typeof document !== "undefined" &&
          document.visibilityState === "visible" &&
          pathnameRef.current !== "/dashboard/notifications"
        ) {
          const { notification } = payload.data;
          toast(notification.title, {
            description: notification.message,
            action: notification.link ? { label: "View", onClick: () => router.push(notification.link) } : undefined,
          });
        }
      },
      onFatal: (reason) => {
        // Access was revoked server-side. One authenticated call lets the existing
        // axios handling show the blocked screen or sign the user out.
        const user = useAuthStore.getState().user;
        if (reason === "blocked" && user && !user.orgBlocked) {
          useAuthStore.getState().setUser({ ...user, orgBlocked: true });
        } else {
          queryClient.invalidateQueries({ queryKey: KEYS.unread });
        }
      },
    });

    return () => {
      stop();
    };
  }, [enabled, userId, queryClient, router]);

  // Never leave one account's notifications in the cache after sign-out.
  useEffect(() => {
    if (!enabled) queryClient.removeQueries({ queryKey: KEYS.all });
  }, [enabled, queryClient]);

  return null;
}
