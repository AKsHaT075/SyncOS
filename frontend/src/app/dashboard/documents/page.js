"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, FilePlus2, FileText, FolderPlus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import Breadcrumbs from "@/features/documents/components/Breadcrumbs";
import ConfirmDialog from "@/features/documents/components/ConfirmDialog";
import DocumentDetailsSheet from "@/features/documents/components/DocumentDetailsSheet";
import DocumentList from "@/features/documents/components/DocumentList";
import DocumentToolbar from "@/features/documents/components/DocumentToolbar";
import FolderTree from "@/features/documents/components/FolderTree";
import MoveDialog from "@/features/documents/components/MoveDialog";
import NameDialog from "@/features/documents/components/NameDialog";
import ShareDialog from "@/features/documents/components/ShareDialog";
import UploadDocumentDialog from "@/features/documents/components/UploadDocumentDialog";
import VisibilityDialog from "@/features/documents/components/VisibilityDialog";
import {
  useCreateFolder,
  useDeleteDocument,
  useDeleteFolder,
  useDocuments,
  useFolders,
  useMoveDocument,
  useUpdateDocument,
  useUpdateFolder,
} from "@/features/documents/hooks/documentHooks";
import { folderNameSchema, renameSchema } from "@/features/documents/schemas/documentSchemas";

const PAGE_SIZE = 24;
const EMPTY_FILTERS = { search: "", category: "", ownerId: "", uploadedFrom: "", uploadedTo: "", scope: "all" };

// Date inputs are local dates; send whole-day UTC bounds the API can parse.
const startOfDay = (value) => (value ? new Date(`${value}T00:00:00`).toISOString() : undefined);
const endOfDay = (value) => (value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined);

function LibraryPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder");
  const docParam = searchParams.get("doc");

  const [view, setView] = useState("table");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ sortBy: "updatedAt", sortOrder: "desc" });
  const [page, setPage] = useState(1);

  // dialog: { type, target }
  const [dialog, setDialog] = useState({ type: null, target: null });
  const [detailsId, setDetailsId] = useState(null);

  // Deep link from a notification: /dashboard/documents?doc=<id> opens that document's details.
  useEffect(() => {
    if (docParam) setDetailsId(docParam);
  }, [docParam]);
  const close = () => setDialog({ type: null, target: null });
  const openDialog = (type) => (target) => setDialog({ type, target });

  const debouncedSearch = useDebouncedValue(filters.search);
  const hasActiveFilters = Boolean(filters.search || filters.category || filters.ownerId || filters.uploadedFrom || filters.uploadedTo || filters.scope !== "all");
  const isBrowsing = !hasActiveFilters;

  useEffect(() => setPage(1), [debouncedSearch, filters.category, filters.ownerId, filters.uploadedFrom, filters.uploadedTo, filters.scope, sort, folderId]);

  const navigateToFolder = useCallback(
    (id) => router.push(id ? `${pathname}?folder=${id}` : pathname),
    [router, pathname],
  );

  const query = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...sort,
      scope: filters.scope,
      ...(isBrowsing ? { folderId: folderId ?? "root" } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
      ...(filters.uploadedFrom ? { uploadedFrom: startOfDay(filters.uploadedFrom) } : {}),
      ...(filters.uploadedTo ? { uploadedTo: endOfDay(filters.uploadedTo) } : {}),
    }),
    [page, sort, filters, isBrowsing, folderId, debouncedSearch],
  );

  const documentsQuery = useDocuments(query);
  const childFolders = useFolders({ parentId: folderId ?? "root" });
  const allFolders = useFolders({ all: "true" });

  const documents = documentsQuery.data?.documents ?? [];
  const pagination = documentsQuery.data?.pagination;
  const folders = isBrowsing ? childFolders.data?.folders ?? [] : [];
  const trail = childFolders.data?.breadcrumb ?? [];
  const currentFolderName = trail.at(-1)?.name;

  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();
  const updateDocument = useUpdateDocument();
  const moveDocument = useMoveDocument();
  const deleteDocument = useDeleteDocument();

  // If the open folder disappears (deleted elsewhere), fall back to the root.
  useEffect(() => {
    if (folderId && childFolders.isError) navigateToFolder(null);
  }, [folderId, childFolders.isError, navigateToFolder]);

  const patchFilters = (patch) => {
    const { sortBy, sortOrder, ...rest } = patch;
    if (sortBy || sortOrder) setSort((current) => ({ ...current, ...(sortBy ? { sortBy } : {}), ...(sortOrder ? { sortOrder } : {}) }));
    if (Object.keys(rest).length) setFilters((current) => ({ ...current, ...rest }));
  };

  const toggleSort = (field) =>
    setSort((current) => ({
      sortBy: field,
      sortOrder: current.sortBy === field && current.sortOrder === "asc" ? "desc" : field === "name" ? "asc" : "desc",
    }));

  const openDetails = (doc) => setDetailsId(doc.id);

  const actions = {
    onDetails: openDetails,
    onRename: openDialog("rename-document"),
    onMove: openDialog("move-document"),
    onShare: openDialog("share"),
    onVisibility: openDialog("visibility"),
    onDelete: openDialog("delete-document"),
  };
  const folderActions = {
    onRename: openDialog("rename-folder"),
    onMove: openDialog("move-folder"),
    onDelete: openDialog("delete-folder"),
  };

  const isLoading = documentsQuery.isLoading || (isBrowsing && childFolders.isLoading);
  const isError = documentsQuery.isError;
  const isEmpty = !isLoading && !isError && documents.length === 0 && folders.length === 0;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Documents</h1>
          <p className="text-sm text-muted-foreground">Files, folders and resources across your organization.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Can permission={PERMISSIONS.DELETE_DOCUMENT}>
            <Button variant="outline" asChild><Link href="/dashboard/documents/trash"><Trash2 className="size-4" />Trash</Link></Button>
          </Can>
          <Can permission={PERMISSIONS.CREATE_FOLDER}>
            <Button variant="outline" onClick={() => setDialog({ type: "new-folder", target: null })}><FolderPlus className="size-4" />New folder</Button>
          </Can>
          <Can permission={PERMISSIONS.UPLOAD_DOCUMENT}>
            <Button onClick={() => setDialog({ type: "upload", target: null })}><Upload className="size-4" />Upload</Button>
          </Can>
        </div>
      </header>

      <DocumentToolbar
        filters={{ ...filters, ...sort }}
        onChange={patchFilters}
        onClear={() => setFilters(EMPTY_FILTERS)}
        hasActiveFilters={hasActiveFilters}
        view={view}
        onViewChange={setView}
      />

      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="Folder navigation">
          <Card className="sticky top-4 max-h-[calc(100vh-8rem)] gap-2 overflow-y-auto rounded-xl border border-border p-2 shadow-sm ring-0">
            <p className="px-2 pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Folders</p>
            {allFolders.isLoading ? (
              <div className="space-y-1.5 p-1"><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-5/6" /><Skeleton className="h-7 w-4/6" /></div>
            ) : (
              <FolderTree folders={allFolders.data?.folders ?? []} currentId={folderId} trail={trail} onSelect={navigateToFolder} />
            )}
          </Card>
        </aside>

        <section className="min-w-0 space-y-4" aria-label="Documents">
          {isBrowsing ? (
            <Breadcrumbs trail={trail} onNavigate={navigateToFolder} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Showing results from the whole library.{" "}
              <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setFilters(EMPTY_FILTERS)}>
                Back to folders
              </button>
            </p>
          )}

          {isLoading ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading documents">
              {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 w-full rounded-lg" />)}
            </div>
          ) : isError ? (
            <Card className="py-10">
              <EmptyStateCard icon={AlertCircle} title="Couldn’t load documents" description="Check your connection and try again." />
              <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => documentsQuery.refetch()}>Retry</Button></div>
            </Card>
          ) : isEmpty ? (
            <Card className="py-10">
              <EmptyStateCard
                icon={hasActiveFilters ? FileText : FilePlus2}
                title={hasActiveFilters ? "No documents match" : folderId ? "This folder is empty" : "No documents yet"}
                description={hasActiveFilters ? "Try different search terms or clear the filters." : "Upload a file or create a folder to get started."}
              />
            </Card>
          ) : (
            <>
              <DocumentList
                view={view}
                documents={documents}
                folders={folders}
                sortBy={sort.sortBy}
                sortOrder={sort.sortOrder}
                onSort={toggleSort}
                onOpenFolder={navigateToFolder}
                actions={actions}
                folderActions={folderActions}
              />
              {pagination && pagination.pages > 1 ? (
                <nav className="flex items-center justify-between" aria-label="Pagination">
                  <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.pages} · {pagination.total} documents</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button variant="outline" size="sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </nav>
              ) : null}
            </>
          )}
        </section>
      </div>

      <UploadDocumentDialog open={dialog.type === "upload"} onOpenChange={(open) => !open && close()} folderId={folderId} folderName={currentFolderName} />

      <NameDialog
        open={dialog.type === "new-folder"}
        onOpenChange={(open) => !open && close()}
        title="New folder"
        description={`Created in ${currentFolderName ?? "the library root"}.`}
        label="Folder name"
        placeholder="e.g. Contracts"
        submitLabel="Create"
        schema={folderNameSchema}
        isPending={createFolder.isPending}
        onSubmit={(name) => createFolder.mutateAsync({ name, parentId: folderId })}
      />
      <NameDialog
        open={dialog.type === "rename-folder"}
        onOpenChange={(open) => !open && close()}
        title="Rename folder"
        initialValue={dialog.target?.name ?? ""}
        schema={folderNameSchema}
        isPending={updateFolder.isPending}
        onSubmit={(name) => updateFolder.mutateAsync({ id: dialog.target.id, updates: { name } })}
      />
      <NameDialog
        open={dialog.type === "rename-document"}
        onOpenChange={(open) => !open && close()}
        title="Rename document"
        description="The file extension is kept automatically."
        initialValue={dialog.target?.name ?? ""}
        schema={renameSchema}
        isPending={updateDocument.isPending}
        onSubmit={(name) => updateDocument.mutateAsync({ id: dialog.target.id, updates: { name } })}
      />

      <MoveDialog
        open={dialog.type === "move-document" || dialog.type === "move-folder"}
        onOpenChange={(open) => !open && close()}
        item={dialog.target}
        kind={dialog.type === "move-folder" ? "folder" : "document"}
        folders={allFolders.data?.folders ?? []}
        isPending={moveDocument.isPending || updateFolder.isPending}
        onMove={(destination) =>
          dialog.type === "move-folder"
            ? updateFolder.mutateAsync({ id: dialog.target.id, updates: { parentId: destination } })
            : moveDocument.mutateAsync({ id: dialog.target.id, folderId: destination })
        }
      />

      <ShareDialog open={dialog.type === "share"} onOpenChange={(open) => !open && close()} document={dialog.target} />
      <VisibilityDialog open={dialog.type === "visibility"} onOpenChange={(open) => !open && close()} document={dialog.target} />

      <ConfirmDialog
        open={dialog.type === "delete-document"}
        onOpenChange={(open) => !open && close()}
        title={`Move “${dialog.target?.name}” to trash?`}
        description="It disappears for everyone who can see it. You can restore it from the trash."
        confirmLabel="Move to trash"
        destructive
        isPending={deleteDocument.isPending}
        onConfirm={() => deleteDocument.mutateAsync(dialog.target.id).then(close).catch(() => {})}
      />
      <ConfirmDialog
        open={dialog.type === "delete-folder"}
        onOpenChange={(open) => !open && close()}
        title={`Move folder “${dialog.target?.name}” to trash?`}
        description="Everything inside it, including subfolders, goes to the trash too. Restoring the folder brings it all back."
        confirmLabel="Move to trash"
        destructive
        isPending={deleteFolder.isPending}
        onConfirm={() =>
          deleteFolder
            .mutateAsync(dialog.target.id)
            .then(() => {
              if (dialog.target.id === folderId) navigateToFolder(null);
              close();
            })
            .catch(() => {})
        }
      />

      <DocumentDetailsSheet
        documentId={detailsId}
        open={Boolean(detailsId)}
        onOpenChange={(open) => {
          if (open) return;
          setDetailsId(null);
          if (docParam) {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("doc");
            router.replace(params.toString() ? `${pathname}?${params}` : pathname);
          }
        }}
        onShare={(doc) => setDialog({ type: "share", target: doc })}
        onChangeVisibility={(doc) => setDialog({ type: "visibility", target: doc })}
      />
    </div>
  );
}

export default function DocumentsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}>
      <LibraryPage />
    </Suspense>
  );
}
