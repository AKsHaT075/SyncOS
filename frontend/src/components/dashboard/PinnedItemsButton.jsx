"use client";

import { Pin, FileText, Link2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

const TYPE_ICON = { document: FileText, link: Link2 };

export default function PinnedItemsButton({ items }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Pinned items"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
        >
          <Pin className="size-4.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Pinned items</p>
        <div className="space-y-1">
          {items.length === 0 ? (
            <EmptyStateCard icon={Pin} title="Nothing pinned yet" />
          ) : (
            items.map((item) => {
              const Icon = TYPE_ICON[item.type] ?? FileText;
              return (
                <div key={item.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-zinc-50">
                  <Icon className="size-3.5 shrink-0 text-zinc-400" />
                  <span className="truncate text-sm text-zinc-800">{item.title}</span>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
