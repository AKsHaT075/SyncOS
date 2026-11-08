"use client";

import { FolderInput, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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

export function useCanModifyFolder(folder) {
  const user = useAuthStore((state) => state.user);
  const permissions = useAuthStore((state) => state.permissions);
  const isAdmin = user?.role === "org-admin" || user?.role === "admin";
  const isOwner = Boolean(user?.id) && folder.owner?.id === user.id;
  return {
    canModify: (isAdmin || isOwner) && permissions.includes(PERMISSIONS.CREATE_FOLDER),
    canDelete: (isAdmin || isOwner) && permissions.includes(PERMISSIONS.DELETE_DOCUMENT),
  };
}

export default function FolderActionsMenu({ folder, onRename, onMove, onDelete }) {
  const { canModify, canDelete } = useCanModifyFolder(folder);
  if (!canModify && !canDelete) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for folder ${folder.name}`} onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48" onClick={(event) => event.stopPropagation()}>
        {canModify ? <DropdownMenuItem onSelect={() => onRename(folder)}><Pencil />Rename</DropdownMenuItem> : null}
        {canModify ? <DropdownMenuItem onSelect={() => onMove(folder)}><FolderInput />Move to…</DropdownMenuItem> : null}
        {canDelete ? (
          <>
            {canModify ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(folder)}><Trash2 />Move to trash</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
