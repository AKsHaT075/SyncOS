"use client";

import { Download, ExternalLink, Share2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import ActivityList from "@/features/documents/components/ActivityList";
import FileTypeIcon from "@/features/documents/components/FileTypeIcon";
import VersionHistory from "@/features/documents/components/VersionHistory";
import VisibilityBadge from "@/features/documents/components/VisibilityBadge";
import { useDocument } from "@/features/documents/hooks/documentHooks";
import { canPreview, downloadDocument, previewDocument } from "@/features/documents/utils/files";
import { formatDate, formatSize } from "@/features/documents/utils/format";

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export default function DocumentDetailsSheet({ documentId, open, onOpenChange, onShare, onChangeVisibility }) {
  const { data, isLoading, isError } = useDocument(open ? documentId : null);
  const doc = data?.document;
  const trail = data?.breadcrumb ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="sr-only">Document details</SheetTitle>
          <SheetDescription className="sr-only">Details, version history and activity for the selected document.</SheetDescription>
          {isLoading ? (
            <Skeleton className="h-12 w-3/4" />
          ) : doc ? (
            <div className="flex items-start gap-3 pr-8">
              <FileTypeIcon category={doc.category} className="size-11" iconClassName="size-5" />
              <div className="min-w-0">
                <h2 className="text-base font-semibold break-words text-foreground">{doc.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {doc.extension.toUpperCase()} · {formatSize(doc.size)} · Version {doc.currentVersion}
                </p>
              </div>
            </div>
          ) : null}
        </SheetHeader>

        <div className="flex-1 p-4">
          {isError ? (
            <p role="alert" className="text-sm text-destructive">This document isn’t available any more.</p>
          ) : isLoading || !doc ? (
            <div className="space-y-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-32 w-full" /></div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => downloadDocument(doc)}><Download className="size-4" />Download</Button>
                {canPreview(doc) ? (
                  <Button size="sm" variant="outline" onClick={() => previewDocument(doc)}><ExternalLink className="size-4" />Preview</Button>
                ) : null}
                {doc.access?.canManage ? (
                  <Can permission={PERMISSIONS.SHARE_DOCUMENT}>
                    <Button size="sm" variant="outline" onClick={() => onShare(doc)}><Share2 className="size-4" />Share</Button>
                  </Can>
                ) : null}
              </div>

              <Tabs defaultValue="details">
                <TabsList className="w-full">
                  <TabsTrigger value="details">Details</TabsTrigger>
                  {doc.access?.canEdit ? <TabsTrigger value="versions">Versions</TabsTrigger> : null}
                  {doc.access?.canEdit ? <TabsTrigger value="activity">Activity</TabsTrigger> : null}
                </TabsList>

                <TabsContent value="details" className="mt-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
                    <Field label="Owner">{doc.owner?.fullName ?? "—"}</Field>
                    <Field label="Location">{trail.length ? trail.map((crumb) => crumb.name).join(" / ") : "Library root"}</Field>
                    <Field label="Uploaded">{formatDate(doc.createdAt, true)}</Field>
                    <Field label="Last modified">{formatDate(doc.updatedAt, true)}</Field>
                    <Field label="Type">{doc.mimeType}</Field>
                    <Field label="Shared with">{doc.sharedCount} {doc.sharedCount === 1 ? "person" : "people"}</Field>
                    <div className="col-span-2">
                      <dt className="text-xs text-muted-foreground">Visibility</dt>
                      <dd className="mt-1 flex items-center gap-2">
                        <VisibilityBadge document={doc} />
                        {doc.access?.canManage ? (
                          <Can permission={PERMISSIONS.SHARE_DOCUMENT}>
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onChangeVisibility(doc)}>Change</Button>
                          </Can>
                        ) : null}
                      </dd>
                    </div>
                    {doc.description ? <div className="col-span-2"><Field label="Description">{doc.description}</Field></div> : null}
                  </dl>
                  <p className="mt-5 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    <ShieldCheck className="size-3.5 shrink-0" />
                    {doc.access?.isOwner
                      ? "You own this document."
                      : doc.access?.sharePermission
                        ? `Shared with you as ${doc.access.sharePermission}.`
                        : doc.access?.canManage
                          ? "You can manage this as an administrator."
                          : "You can view this through its visibility settings."}
                  </p>
                </TabsContent>

                {doc.access?.canEdit ? <TabsContent value="versions" className="mt-4"><VersionHistory document={doc} /></TabsContent> : null}
                {doc.access?.canEdit ? <TabsContent value="activity" className="mt-4"><ActivityList documentId={doc.id} /></TabsContent> : null}
              </Tabs>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
