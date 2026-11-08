"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Folder, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import ConfirmDialog from "@/features/documents/components/ConfirmDialog";
import FileTypeIcon from "@/features/documents/components/FileTypeIcon";
import {
  usePurgeDocument,
  usePurgeFolder,
  useRestoreDocument,
  useRestoreFolder,
  useTrash,
} from "@/features/documents/hooks/documentHooks";
import { formatDate, formatSize } from "@/features/documents/utils/format";

function Row({ icon, name, meta, onRestore, onPurge, restoring }){
  return (
  <li className="flex items-center gap-3 px-4 py-3">
    {icon}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-foreground">{name}</p>
      <p className="truncate text-xs text-muted-foreground">{meta}</p>
    </div>
    <Button variant="outline" size="sm" onClick={onRestore} disabled={restoring}><RotateCcw className="size-4" />Restore</Button>
    <Can permission={PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT}>
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onPurge}><Trash2 className="size-4" />Delete forever</Button>
    </Can>
  </li>
);
}

export default function DocumentTrashPage() {
  const [page, setPage] = useState(1);
  const [purge, setPurge] = useState(null); // { kind, item }
  const { data, isLoading, isError, refetch } = useTrash({ page, limit: 24 });

  const restoreDocument = useRestoreDocument();
  const restoreFolder = useRestoreFolder();
  const purgeDocument = usePurgeDocument();
  const purgeFolder = usePurgeFolder();

  const documents = data?.documents ?? [];
  const folders = data?.folders ?? [];
  const pagination = data?.pagination;
  const isEmpty = !isLoading && !isError && documents.length === 0 && folders.length === 0;
  const purging = purgeDocument.isPending || purgeFolder.isPending;

  const confirmPurge = () => {
    const mutation = purge.kind === "folder" ? purgeFolder : purgeDocument;
    mutation.mutateAsync(purge.item.id).then(() => setPurge(null)).catch(() => {});
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <header className="space-y-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2"><Link href="/dashboard/documents"><ArrowLeft className="size-4" />Documents</Link></Button>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Trash</h1>
        <p className="text-sm text-muted-foreground">
          Deleted items stay here until restored{" "}
          <Can permission={PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT} fallback="or removed by an administrator.">or deleted forever.</Can>
          {" "}Restoring a folder brings back everything that was deleted with it.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : isError ? (
        <Card className="py-10">
          <EmptyStateCard icon={AlertCircle} title="Couldn’t load the trash" description="Check your connection and try again." />
          <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button></div>
        </Card>
      ) : isEmpty ? (
        <Card className="py-10"><EmptyStateCard icon={Trash2} title="The trash is empty" description="Documents and folders you delete will show up here." /></Card>
      ) : (
        <>
          <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
            <ul className="divide-y divide-border" aria-label="Deleted items">
              {folders.map((folder) => (
                <Row
                  key={folder.id}
                  icon={<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><Folder className="size-4.5" /></span>}
                  name={folder.name}
                  meta={`Folder · deleted ${formatDate(folder.deletedAt, true)}`}
                  restoring={restoreFolder.isPending}
                  onRestore={() => restoreFolder.mutate(folder.id)}
                  onPurge={() => setPurge({ kind: "folder", item: folder })}
                />
              ))}
              {documents.map((doc) => (
                <Row
                  key={doc.id}
                  icon={<FileTypeIcon category={doc.category} />}
                  name={doc.name}
                  meta={`${formatSize(doc.size)} · ${doc.owner?.fullName ?? "Unknown"} · deleted ${formatDate(doc.deletedAt, true)}`}
                  restoring={restoreDocument.isPending}
                  onRestore={() => restoreDocument.mutate(doc.id)}
                  onPurge={() => setPurge({ kind: "document", item: doc })}
                />
              ))}
            </ul>
          </Card>
          {pagination && pagination.pages > 1 ? (
            <nav className="flex items-center justify-between" aria-label="Pagination">
              <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.pages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button variant="outline" size="sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </nav>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={Boolean(purge)}
        onOpenChange={(open) => !open && setPurge(null)}
        title={`Permanently delete “${purge?.item?.name}”?`}
        description={
          purge?.kind === "folder"
            ? "The folder, everything inside it and every version of those files will be erased. This can’t be undone."
            : "The file and all of its versions will be erased. This can’t be undone."
        }
        confirmLabel="Delete forever"
        destructive
        isPending={purging}
        onConfirm={confirmPurge}
      />
    </div>
  );
}
