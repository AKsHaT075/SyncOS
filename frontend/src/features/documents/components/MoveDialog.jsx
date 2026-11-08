"use client";

import { useEffect, useMemo, useState } from "react";
import { Folder, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { buildFolderTree } from "@/features/documents/components/FolderTree";

function flatten(byParent, parent = "root", depth = 0, skip = new Set()) {
  return (byParent.get(parent) ?? []).flatMap((folder) =>
    skip.has(folder.id) ? [] : [{ folder, depth }, ...flatten(byParent, folder.id, depth + 1, skip)],
  );
}

/**
 * Destination picker for moving a document or folder. When moving a folder,
 * the folder itself (and therefore its whole subtree) is not offered — the
 * server rejects it too, this just avoids the dead end.
 */
export default function MoveDialog({ open, onOpenChange, item, kind, folders, isPending, onMove }) {
  const [selected, setSelected] = useState(null);
  const currentParent = kind === "folder" ? item?.parent ?? null : item?.folder ?? null;

  useEffect(() => {
    if (open) setSelected(currentParent);
  }, [open, currentParent]);

  const rows = useMemo(() => {
    const byParent = buildFolderTree(folders);
    return flatten(byParent, "root", 0, kind === "folder" && item ? new Set([item.id]) : new Set());
  }, [folders, item, kind]);

  const submit = async () => {
    try {
      await onMove(selected);
      onOpenChange(false);
    } catch {
      /* error toast already shown */
    }
  };

  const options = [{ folder: { id: null, name: "Library root" }, depth: 0 }, ...rows];

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move “{item?.name}”</DialogTitle>
          <DialogDescription>Choose where this {kind} should live.</DialogDescription>
        </DialogHeader>
        <div role="listbox" aria-label="Destination folder" className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
          {options.map(({ folder, depth }) => {
            const active = selected === folder.id;
            const Icon = active ? FolderOpen : Folder;
            return (
              <button
                key={folder.id ?? "root"}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => setSelected(folder.id)}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{folder.name}</span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending || selected === currentParent}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
