"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CATEGORY_FILTERS } from "@/features/notifications/constants/notificationOptions";

export default function NotificationFilters({ status, onStatusChange, category, onCategoryChange, unreadLabel }) {
  return (
    <div className="space-y-3">
      <Tabs value={status} onValueChange={onStatusChange}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">{unreadLabel ? `Unread (${unreadLabel})` : "Unread"}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
        {[{ value: "", label: "All categories" }, ...CATEGORY_FILTERS].map((option) => {
          const active = (category || "") === option.value;
          return (
            <button
              key={option.value || "all"}
              type="button"
              aria-pressed={active}
              onClick={() => onCategoryChange(option.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
