"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/store/useAuthStore";
import { useMarkTypesRead, useUnreadByType } from "@/features/notifications/hooks/notificationHooks";
import { unreadTypesForPath } from "@/features/notifications/utils/sectionBadges";

/**
 * Opening a section clears its badge: after the page has been on screen for a moment, unread notifications that
 * belong to exactly this page are marked read. Renders nothing.
 */
export default function SectionBadgeSync() {
  const pathname = usePathname();
  const permissions = useAuthStore((state) => state.permissions);
  const { data } = useUnreadByType();
  const { mutate } = useMarkTypesRead();
  const counts = data?.counts;

  useEffect(() => {
    const types = unreadTypesForPath(counts, pathname, (permission) => permissions.includes(permission));
    if (!types.length) return undefined;
    const timer = setTimeout(() => mutate(types), 1200);
    return () => clearTimeout(timer);
  }, [counts, pathname, permissions, mutate]);

  return null;
}
