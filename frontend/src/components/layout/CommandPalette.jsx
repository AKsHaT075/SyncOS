"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useUIStore } from "@/store/useUIStore";
import { NAV_ITEMS, QUICK_LINKS } from "@/components/layout/navConfig";

// Placeholder results until search hits a real endpoint — wire up
// project/task/document search here once those modules exist.
const MOCK_RESULTS = {
  Projects: ["Project Phoenix", "Mobile Revamp"],
  Tasks: ["Set up CI pipeline", "Draft Q3 roadmap"],
  Documents: ["Onboarding guide", "Security policy"],
  Meetings: ["Weekly sync", "Design review"],
};

export default function CommandPalette() {
  const open = useUIStore((state) => state.commandPaletteOpen);
  const setOpen = useUIStore((state) => state.setCommandPaletteOpen);
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!open);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen]);

  const navigate = (href) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages, projects, tasks, documents..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          {[...NAV_ITEMS, ...QUICK_LINKS].map((item) => (
            <CommandItem key={item.href} onSelect={() => navigate(item.href)}>
              <item.icon className="size-4" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {Object.entries(MOCK_RESULTS).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((label) => (
              <CommandItem key={label} onSelect={() => setOpen(false)}>
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => navigate("/dashboard/settings")}>
            Open settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
