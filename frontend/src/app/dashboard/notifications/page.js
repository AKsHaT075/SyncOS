"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NotificationFilters from "@/features/notifications/components/NotificationFilters";
import NotificationList from "@/features/notifications/components/NotificationList";
import NotificationPreferences from "@/features/notifications/components/NotificationPreferences";
import { useNotificationActions } from "@/features/notifications/components/useNotificationActions";
import { formatBadge } from "@/features/notifications/components/NotificationBell";
import { PAGE_LIMIT } from "@/features/notifications/constants/notificationOptions";
import { useNotifications, useUnreadCount } from "@/features/notifications/hooks/notificationHooks";

function Inbox() {
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("");

  const feed = useNotifications({ status, category: category || undefined, limit: PAGE_LIMIT });
  const unread = useUnreadCount();
  const actions = useNotificationActions();

  const notifications = feed.data?.pages.flatMap((page) => page.notifications) ?? [];
  const count = unread.data?.count ?? 0;
  const badge = formatBadge(count, unread.data?.capped);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <NotificationFilters
          status={status}
          onStatusChange={setStatus}
          category={category}
          onCategoryChange={setCategory}
          unreadLabel={badge}
        />
        <Button variant="outline" disabled={count === 0 || actions.isMarkingAll} onClick={() => actions.markAllRead(category || undefined)}>
          <CheckCheck className="size-4" />
          {category ? "Mark category as read" : "Mark all as read"}
        </Button>
      </div>

      <Card className="gap-0 overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
        <NotificationList
          notifications={notifications}
          isLoading={feed.isLoading}
          isError={feed.isError}
          onRetry={() => feed.refetch()}
          onOpen={actions.open}
          onMarkRead={actions.markRead}
          onDismiss={actions.dismiss}
          status={status}
          category={category}
          hasNextPage={Boolean(feed.hasNextPage)}
          isFetchingNextPage={feed.isFetchingNextPage}
          onLoadMore={() => feed.fetchNextPage()}
        />
      </Card>
    </div>
  );
}

function NotificationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") === "preferences" ? "preferences" : "inbox";

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Notifications</h1>
        <p className="text-sm text-muted-foreground">Stay on top of what happens across your work.</p>
      </header>

      <Tabs value={tab} onValueChange={(next) => router.replace(next === "preferences" ? `${pathname}?tab=preferences` : pathname)}>
        <TabsList>
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="mt-4"><Inbox /></TabsContent>
        <TabsContent value="preferences" className="mt-4"><NotificationPreferences /></TabsContent>
      </Tabs>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-3xl p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}>
      <NotificationsPage />
    </Suspense>
  );
}
