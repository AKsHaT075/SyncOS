import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { documentService } from "@/features/documents/services/documentService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const KEY = "documents";

export const useDocuments = (params) =>
  useQuery({
    queryKey: [KEY, "list", params],
    queryFn: () => documentService.list(params),
    placeholderData: keepPreviousData,
  });

export const useDocument = (id) =>
  useQuery({ queryKey: [KEY, "detail", id], queryFn: () => documentService.get(id), enabled: !!id });

export const useFolders = (params) =>
  useQuery({ queryKey: [KEY, "folders", params], queryFn: () => documentService.listFolders(params) });

export const useDocumentShares = (id, enabled = true) =>
  useQuery({ queryKey: [KEY, "shares", id], queryFn: () => documentService.listShares(id), enabled: !!id && enabled });

export const useDocumentVersions = (id, enabled = true) =>
  useQuery({ queryKey: [KEY, "versions", id], queryFn: () => documentService.listVersions(id), enabled: !!id && enabled });

export const useDocumentActivity = (id, enabled = true) =>
  useQuery({ queryKey: [KEY, "activity", id], queryFn: () => documentService.activity(id, { limit: 30 }), enabled: !!id && enabled });

export const useTrash = (params) =>
  useQuery({ queryKey: [KEY, "trash", params], queryFn: () => documentService.listTrash(params), placeholderData: keepPreviousData });

// Everything document-related refreshes together; the dataset is small per view
// and this keeps lists, folder trees, details and trash from drifting apart.
function useDocumentMutation(mutationFn, { success, onSuccess } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: [KEY] });
      const message = typeof success === "function" ? success(data, variables) : success;
      if (message) toast.success(message);
      onSuccess?.(data, variables);
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export const useUploadDocument = () =>
  useDocumentMutation((args) => documentService.upload(args), { success: (data) => `"${data.document.name}" uploaded` });

export const useUpdateDocument = () =>
  useDocumentMutation(({ id, updates }) => documentService.update(id, updates), { success: "Document updated" });

export const useMoveDocument = () =>
  useDocumentMutation(({ id, folderId }) => documentService.move(id, folderId), { success: "Document moved" });

export const useDeleteDocument = () =>
  useDocumentMutation((id) => documentService.remove(id), { success: "Moved to trash" });

export const useAddShare = () =>
  useDocumentMutation(({ id, ...payload }) => documentService.addShare(id, payload), { success: "Access updated" });

export const useRevokeShare = () =>
  useDocumentMutation(({ id, userId }) => documentService.revokeShare(id, userId), { success: "Access revoked" });

export const useUploadVersion = () =>
  useDocumentMutation((args) => documentService.uploadVersion(args), { success: (data) => `Version ${data.version} uploaded` });

export const useRestoreVersion = () =>
  useDocumentMutation(({ id, version }) => documentService.restoreVersion(id, version), {
    success: (data) => `Restored as version ${data.version}`,
  });

export const useCreateFolder = () =>
  useDocumentMutation((payload) => documentService.createFolder(payload), { success: (data) => `Folder "${data.folder.name}" created` });

export const useUpdateFolder = () =>
  useDocumentMutation(({ id, updates }) => documentService.updateFolder(id, updates), { success: "Folder updated" });

export const useDeleteFolder = () =>
  useDocumentMutation((id) => documentService.deleteFolder(id), { success: "Folder moved to trash" });

export const useRestoreDocument = () =>
  useDocumentMutation((id) => documentService.restoreDocument(id), {
    success: (data) => (data.restoredToRoot ? "Restored to the library root" : "Document restored"),
  });

export const usePurgeDocument = () =>
  useDocumentMutation((id) => documentService.purgeDocument(id), { success: "Permanently deleted" });

export const useRestoreFolder = () =>
  useDocumentMutation((id) => documentService.restoreFolder(id), { success: "Folder restored" });

export const usePurgeFolder = () =>
  useDocumentMutation((id) => documentService.purgeFolder(id), { success: "Folder permanently deleted" });
