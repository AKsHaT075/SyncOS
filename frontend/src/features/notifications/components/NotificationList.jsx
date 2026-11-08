"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, BellOff, CheckCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import NotificationItem from "@/features/notifications/components/NotificationItem";

function ListSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-1 p-3" aria-busy="true" aria-label="Loading notifications">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-start gap-3 px-1 py-2">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Presentational list with every state: loading, error (retry), empty
 * (tailored to the active filter) and items, plus optional infinite scroll
 * (IntersectionObserver sentinel with a "Load more" button as the fallback).
 */
export default function NotificationList({
  notifications,
  isLoading,
  isError,
  onRetry,
  onOpen,
  onMarkRead,
  onDismiss,
  compact = false,
  status = "all",
  category,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  skeletonRows,
}) {
  const sentinel = useRef(null);

  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage || !sentinel.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onLoadMore();
    }, { rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [onLoadMore, hasNextPage, isFetchingNextPage, notifications.length]);

  if (isLoading) return <ListSkeleton rows={skeletonRows} />;

  if (isError) {
    return (
      <div className="py-8">
        <EmptyStateCard icon={AlertCircle} title="Couldn’t load notifications" description="Check your connection and try again." />
        <div className="flex justify-center"><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button></div>
      </div>
    );
  }

  if (notifications.length === 0) {
    const filtered = status === "unread" || category;
    return (
      <div className="py-8">
        <EmptyStateCard
          icon={status === "unread" && !category ? CheckCheck : BellOff}
          title={status === "unread" && !category ? "You’re all caught up" : filtered ? "Nothing here" : "No notifications yet"}
          description={filtered ? "No notifications match these filters." : "Updates about your tasks, projects, meetings and documents will show up here."}
        />
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-border" aria-label="Notifications">
        {notifications.map((notification) => (
          <NotificationItem
            key={notification.id}
            notification={notification}
            compact={compact}
            onOpen={onOpen}
            onMarkRead={onMarkRead}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
      {onLoadMore ? (
        <div ref={sentinel} className="flex justify-center p-3">
          {isFetchingNextPage ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading more" />
          ) : hasNextPage ? (
            <Button variant="ghost" size="sm" onClick={onLoadMore}>Load more</Button>
          ) : (
            <p className="text-xs text-muted-foreground">You’ve reached the end.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
