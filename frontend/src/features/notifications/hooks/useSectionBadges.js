import { useCallback } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { useUnreadByType } from "@/features/notifications/hooks/notificationHooks";
import { countForHref } from "@/features/notifications/utils/sectionBadges";

/** `badgeFor(href, { exact })` → unread notifications that belong to that section of the app. */
export function useSectionBadges() {
  const permissions = useAuthStore((state) => state.permissions);
  const { data } = useUnreadByType();
  const counts = data?.counts;
  const badgeFor = useCallback(
    (href, options) => countForHref(counts, href, (permission) => permissions.includes(permission), options),
    [counts, permissions],
  );
  return { badgeFor, counts };
}
