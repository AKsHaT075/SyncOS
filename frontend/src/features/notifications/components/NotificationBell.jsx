"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthStore } from "@/store/useAuthStore";
import NotificationList from "@/features/notifications/components/NotificationList";
import { useNotificationActions } from "@/features/notifications/components/useNotificationActions";
import { POPOVER_LIMIT } from "@/features/notifications/constants/notificationOptions";
import { useNotifications, useUnreadCount } from "@/features/notifications/hooks/notificationHooks";

export function formatBadge(count, capped) {
  if (!count) return null;
  return capped || count > 99 ? "99+" : String(count);
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("all");
  const enabled = useAuthStore((state) => Boolean(state.organization) && !state.user?.orgBlocked);

  const unread = useUnreadCount({ enabled });
  const count = unread.data?.count ?? 0;
  const badge = formatBadge(count, unread.data?.capped);

  // Only fetch the preview while the popover is open; the live stream keeps it current afterwards.
  const feed = useNotifications({ status, limit: POPOVER_LIMIT, enabled: enabled && open });
  const items = (feed.data?.pages[0]?.notifications ?? []).slice(0, POPOVER_LIMIT);
  const actions = useNotificationActions({ onNavigate: () => setOpen(false) });

  if (!enabled) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="relative flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-ring dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              aria-label={count ? `Notifications, ${badge} unread` : "Notifications"}
            >
              <Bell className="size-4.5" />
              {badge ? (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background">
                  {badge}
                </span>
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Notifications</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">{count ? `${badge} unread notifications` : ""}</span>

      <PopoverContent align="end" sideOffset={8} className="w-[min(94vw,26rem)] gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={count === 0 || actions.isMarkingAll} onClick={() => actions.markAllRead()}>
              <CheckCheck className="size-4" />Mark all read
            </Button>
            <Button variant="ghost" size="icon-sm" asChild aria-label="Notification settings">
              <Link href="/dashboard/notifications?tab=preferences" onClick={() => setOpen(false)}><Settings className="size-4" /></Link>
            </Button>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2">
          <Tabs value={status} onValueChange={setStatus}>
            <TabsList className="w-full">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="unread">Unread{count ? ` (${badge})` : ""}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="max-h-[26rem] overflow-y-auto">
          <NotificationList
            compact
            notifications={items}
            isLoading={feed.isLoading}
            isError={feed.isError}
            onRetry={() => feed.refetch()}
            onOpen={actions.open}
            onMarkRead={actions.markRead}
            onDismiss={actions.dismiss}
            status={status}
            skeletonRows={4}
          />
        </div>

        <div className="border-t border-border p-2">
          <Button variant="ghost" className="w-full" asChild>
            <Link href="/dashboard/notifications" onClick={() => setOpen(false)}>View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
