"use client";

import { ArrowDown, ArrowUp, Folder } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import DocumentActionsMenu from "@/features/documents/components/DocumentActionsMenu";
import FileTypeIcon from "@/features/documents/components/FileTypeIcon";
import FolderActionsMenu from "@/features/documents/components/FolderActionsMenu";
import VisibilityBadge from "@/features/documents/components/VisibilityBadge";
import { formatDate, formatSize } from "@/features/documents/utils/format";

function SortableHead({ field, label, sortBy, sortOrder, onSort, className = "" }) {
  const active = sortBy === field;
  const Icon = sortOrder === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
      className={`h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${className}`}
    >
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 rounded uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {label}
        {active ? <Icon className="size-3" aria-hidden="true" /> : null}
      </button>
    </TableHead>
  );
}

const headClass = "h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export default function DocumentList({ view, documents, folders = [], sortBy, sortOrder, onSort, onOpenFolder, actions, folderActions }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {folders.map((folder) => (
          <Card key={folder.id} className="group flex-row items-center gap-3 rounded-xl border border-border p-3 shadow-sm ring-0 transition-colors hover:bg-muted/40">
            <button type="button" onClick={() => onOpenFolder(folder.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><Folder className="size-5" /></span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{folder.name}</span>
                <span className="block truncate text-xs text-muted-foreground">Folder · {folder.owner?.fullName ?? ""}</span>
              </span>
            </button>
            <FolderActionsMenu folder={folder} {...folderActions} />
          </Card>
        ))}
        {documents.map((doc) => (
          <Card key={doc.id} className="group gap-3 rounded-xl border border-border p-4 shadow-sm ring-0 transition-colors hover:bg-muted/40">
            <div className="flex items-start justify-between gap-2">
              <button type="button" onClick={() => actions.onDetails(doc)} className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring">
                <FileTypeIcon category={doc.category} className="size-10" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{doc.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{doc.extension.toUpperCase()} · {formatSize(doc.size)}</span>
                </span>
              </button>
              <DocumentActionsMenu document={doc} {...actions} />
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <VisibilityBadge document={doc} />
              <span className="shrink-0">{formatDate(doc.updatedAt)}</span>
            </div>
            <p className="truncate text-xs text-muted-foreground">{doc.owner?.fullName}</p>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
            <SortableHead field="name" label="Name" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} className="pl-5" />
            <TableHead className={`${headClass} hidden md:table-cell`}>Owner</TableHead>
            <TableHead className={`${headClass} hidden lg:table-cell`}>Access</TableHead>
            <SortableHead field="updatedAt" label="Modified" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} className="hidden sm:table-cell" />
            <SortableHead field="size" label="Size" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} className="hidden sm:table-cell" />
            <TableHead className="w-12 pr-3"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.map((folder) => (
            <TableRow key={folder.id} className="cursor-pointer" onClick={() => onOpenFolder(folder.id)}>
              <TableCell className="pl-5">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onOpenFolder(folder.id); }}
                  className="flex items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><Folder className="size-4.5" /></span>
                  <span className="truncate text-sm font-medium text-foreground">{folder.name}</span>
                </button>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{folder.owner?.fullName}</TableCell>
              <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">—</TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{formatDate(folder.updatedAt)}</TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">—</TableCell>
              <TableCell className="pr-3 text-right"><FolderActionsMenu folder={folder} {...folderActions} /></TableCell>
            </TableRow>
          ))}
          {documents.map((doc) => (
            <TableRow key={doc.id} className="cursor-pointer" onClick={() => actions.onDetails(doc)}>
              <TableCell className="max-w-0 pl-5">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); actions.onDetails(doc); }}
                  className="flex w-full min-w-0 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <FileTypeIcon category={doc.category} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{doc.name}</span>
                    <span className="block truncate text-xs text-muted-foreground sm:hidden">{formatSize(doc.size)} · {formatDate(doc.updatedAt)}</span>
                  </span>
                </button>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{doc.owner?.fullName}</TableCell>
              <TableCell className="hidden lg:table-cell"><VisibilityBadge document={doc} /></TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{formatDate(doc.updatedAt)}</TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{formatSize(doc.size)}</TableCell>
              <TableCell className="pr-3 text-right"><DocumentActionsMenu document={doc} {...actions} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
