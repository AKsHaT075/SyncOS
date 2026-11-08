"use client";

import { Check, Lock, X } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { notificationVisual } from "@/features/notifications/constants/notificationOptions";

function timeAgo(value) {
  try {
    return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
  } catch {
    return "";
  }
}

/**
 * One notification. The main area is a real link when the destination is
 * available (so open-in-new-tab works) and a plain button otherwise. A
 * notification whose resource the user can no longer reach is shown but never
 * linked — the server withholds both the link and the message.
 */
export default function NotificationItem({ notification, onOpen, onMarkRead, onDismiss, compact = false }) {
  const { icon: Icon, tone } = notificationVisual(notification.type);
  const unread = !notification.read;
  const actionable = Boolean(notification.link);

  const body = (
    <>
      <span className={cn("flex shrink-0 items-center justify-center rounded-lg", tone, compact ? "size-8" : "size-9")} aria-hidden="true">
        {notification.available ? <Icon className={compact ? "size-4" : "size-4.5"} /> : <Lock className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", unread ? "font-semibold text-foreground" : "font-medium text-foreground/80")}>
          {notification.title}
        </span>
        <span className={cn("mt-0.5 block text-sm leading-snug", compact ? "line-clamp-2" : "line-clamp-3", notification.available ? "text-muted-foreground" : "text-muted-foreground/70 italic")}>
          {notification.message}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground/80">
          {notification.actor?.fullName ? `${notification.actor.fullName} · ` : ""}
          <time dateTime={notification.createdAt}>{timeAgo(notification.createdAt)}</time>
        </span>
      </span>
    </>
  );

  const mainClass = "flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring";

  const handleClick = (event) => {
    // Let ctrl/cmd/middle-click open a new tab natively, but still mark it read.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
      if (unread) onMarkRead(notification);
      return;
    }
    event.preventDefault();
    onOpen(notification);
  };

  return (
    <li
      className={cn(
        "group relative flex items-start gap-2 px-4 py-3 transition-colors hover:bg-muted/50",
        unread && "bg-primary/[0.04]",
      )}
    >
      {unread ? <span className="absolute top-5 left-1.5 size-2 rounded-full bg-primary" aria-hidden="true" /> : null}

      {actionable ? (
        <a href={notification.link} onClick={handleClick} onAuxClick={handleClick} className={mainClass}>
          {body}
        </a>
      ) : (
        <button type="button" onClick={() => onOpen(notification)} className={cn(mainClass, !unread && "cursor-default")}>
          {body}
        </button>
      )}

      <span className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        {unread ? (
          <Button variant="ghost" size="icon-sm" aria-label="Mark as read" title="Mark as read" onClick={() => onMarkRead(notification)}>
            <Check className="size-4" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss notification" title="Dismiss" onClick={() => onDismiss(notification)}>
          <X className="size-4" />
        </Button>
      </span>
    </li>
  );
}
