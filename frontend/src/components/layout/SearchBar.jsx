"use client";

import { Search } from "lucide-react";
import { useUIStore } from "@/store/useUIStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function SearchBar({ compact = false }) {
  const setCommandPaletteOpen = useUIStore((state) => state.setCommandPaletteOpen);

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Open search"
            onClick={() => setCommandPaletteOpen(true)}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Search className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-1.5">
          Search
          <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-sans text-[11px] font-medium">⌘K</kbd>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setCommandPaletteOpen(true)}
      className="flex h-8 w-full max-w-sm items-center gap-2 rounded-full bg-zinc-100/80 px-3.5 text-[13px] text-zinc-500 transition-colors duration-200 hover:bg-zinc-200/70 hover:text-zinc-700"
    >
      <Search className="size-3.5 shrink-0 text-zinc-400" />
      <span className="flex-1 truncate text-left">Search</span>
      <kbd className="hidden shrink-0 rounded-md bg-white px-1.5 py-0.5 font-sans text-[11px] font-medium text-zinc-400 shadow-sm ring-1 ring-zinc-900/[0.06] sm:inline-block">
        ⌘K
      </kbd>
    </button>
  );
}
