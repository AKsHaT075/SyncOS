"use client";

import { Users2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function MyTeamButton({ members }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="My team"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
        >
          <Users2 className="size-4.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">My team</p>
        <div className="space-y-1">
          {members.length === 0 ? (
            <EmptyStateCard icon={Users2} title="No teammates yet" />
          ) : (
            members.map((member) => (
              <div key={member.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-zinc-50">
                <Avatar size="sm">
                  <AvatarFallback className="text-[0.6rem]">{initials(member.name)}</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm text-zinc-800">{member.name}</span>
                <span className="ml-auto shrink-0 text-xs text-zinc-400">{member.role}</span>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
