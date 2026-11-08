"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export function buildFolderTree(folders) {
  const byParent = new Map();
  folders.forEach((folder) => {
    const key = folder.parent ?? "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  });
  return byParent;
}

function Node({ folder, byParent, depth, currentId, trailIds, onSelect }) {
  const children = byParent.get(folder.id) ?? [];
  const onTrail = trailIds.has(folder.id);
  const [openState, setOpenState] = useState(null);
  const open = openState ?? onTrail;
  const active = currentId === folder.id;
  const Icon = active || open ? FolderOpen : Folder;

  return (
    <li role="treeitem" aria-expanded={children.length ? open : undefined} aria-selected={active}>
      <div
        className={cn(
          "group flex items-center rounded-md text-sm transition-colors",
          active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          aria-label={open ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
          tabIndex={children.length ? 0 : -1}
          onClick={() => setOpenState(!open)}
          className={cn("flex size-6 shrink-0 items-center justify-center rounded", !children.length && "invisible")}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => onSelect(folder.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 pr-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>
      {open && children.length ? (
        <ul role="group">
          {children.map((child) => (
            <Node key={child.id} folder={child} byParent={byParent} depth={depth + 1} currentId={currentId} trailIds={trailIds} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function FolderTree({ folders = [], currentId, trail = [], onSelect }) {
  const byParent = useMemo(() => buildFolderTree(folders), [folders]);
  const trailIds = useMemo(() => new Set(trail.map((crumb) => crumb.id)), [trail]);
  const roots = byParent.get("root") ?? [];

  return (
    <ul role="tree" aria-label="Folders" className="space-y-0.5">
      <li role="treeitem" aria-selected={!currentId}>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            !currentId ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <FolderOpen className="size-4" />
          Library root
        </button>
      </li>
      {roots.map((folder) => (
        <Node key={folder.id} folder={folder} byParent={byParent} depth={0} currentId={currentId} trailIds={trailIds} onSelect={onSelect} />
      ))}
    </ul>
  );
}
