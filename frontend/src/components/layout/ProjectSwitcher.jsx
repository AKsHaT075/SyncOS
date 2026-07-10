"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown, FolderKanban } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useProject } from "@/features/projects/hooks/useProject";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const PROJECT_ID_PATTERN = /^\/dashboard\/projects\/([^/]+)$|^\/dashboard\/projects\/([^/]+)\//;

export default function ProjectSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  const match = pathname.match(PROJECT_ID_PATTERN);
  const projectId = match ? match[1] || match[2] : null;
  const isNew = pathname === "/dashboard/projects/new";

  const { data: projectData } = useProject(!isNew ? projectId : null);
  const { data: listData, isFetching } = useProjects({ search: debouncedSearch, limit: 20 });
  const projects = listData?.projects ?? [];

  const project = projectData?.project;

  const otherProjects = useMemo(
    () => projects.filter((candidate) => candidate.id !== projectId),
    [projects, projectId]
  );

  if (!projectId || isNew) return null;

  const handleSelect = (id) => {
    setOpen(false);
    setSearch("");
    router.push(`/dashboard/projects/${id}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 max-w-md min-w-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50"
        >
          <FolderKanban className="size-4 shrink-0 text-zinc-400" />
          <span className="whitespace-nowrap">{project?.name || "Loading..."}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <Input
          placeholder="Switch project..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
        <div className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
          {isFetching ? (
            <p className="p-2 text-xs text-muted-foreground">Searching...</p>
          ) : otherProjects.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No other projects found.</p>
          ) : (
            otherProjects.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => handleSelect(candidate.id)}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent"
              >
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-xs"
                  style={candidate.color ? { backgroundColor: `${candidate.color}20` } : undefined}
                >
                  <FolderKanban className="size-3.5 text-zinc-500" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{candidate.name}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
