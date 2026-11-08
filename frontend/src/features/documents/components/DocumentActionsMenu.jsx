"use client";

import { Download, ExternalLink, FolderInput, History, Info, Lock, MoreHorizontal, Pencil, Share2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PERMISSIONS } from "@/constants/permissions";
import { useAuthStore } from "@/store/useAuthStore";
import { canPreview, downloadDocument, previewDocument } from "@/features/documents/utils/files";

/** Context menu for a document. Items reflect server-computed `access`; the API re-checks everything. */
export default function DocumentActionsMenu({ document: doc, onDetails, onRename, onMove, onShare, onVisibility, onDelete, className }) {
  const permissions = useAuthStore((state) => state.permissions);
  const can = (permission) => permissions.includes(permission);
  const access = doc.access ?? {};

  const canRename = access.canEdit;
  const canMove = access.canManage && can(PERMISSIONS.UPLOAD_DOCUMENT);
  const canShare = access.canManage && can(PERMISSIONS.SHARE_DOCUMENT);
  const canDelete = access.canManage && can(PERMISSIONS.DELETE_DOCUMENT);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={className} aria-label={`Actions for ${doc.name}`} onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onDetails(doc)}><Info />Details</DropdownMenuItem>
        {canPreview(doc) ? <DropdownMenuItem onSelect={() => previewDocument(doc)}><ExternalLink />Preview</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={() => downloadDocument(doc)}><Download />Download</DropdownMenuItem>
        {access.canEdit ? <DropdownMenuItem onSelect={() => onDetails(doc, "versions")}><History />Version history</DropdownMenuItem> : null}
        {canRename || canMove || canShare ? <DropdownMenuSeparator /> : null}
        {canRename ? <DropdownMenuItem onSelect={() => onRename(doc)}><Pencil />Rename</DropdownMenuItem> : null}
        {canMove ? <DropdownMenuItem onSelect={() => onMove(doc)}><FolderInput />Move to…</DropdownMenuItem> : null}
        {canShare ? <DropdownMenuItem onSelect={() => onShare(doc)}><Share2 />Share</DropdownMenuItem> : null}
        {canShare ? <DropdownMenuItem onSelect={() => onVisibility(doc)}><Lock />Change access</DropdownMenuItem> : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(doc)}><Trash2 />Move to trash</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
