import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUploadTaskAttachment(projectId, taskId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file) => taskService.uploadAttachment(projectId, taskId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, taskId] });
      toast.success("Attachment uploaded");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useDeleteTaskAttachment(projectId, taskId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (attachmentId) => taskService.removeAttachment(projectId, taskId, attachmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, taskId] });
      toast.success("Attachment removed");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
