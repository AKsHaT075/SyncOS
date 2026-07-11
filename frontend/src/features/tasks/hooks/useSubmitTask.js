import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useSubmitTask(projectId, taskId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => taskService.submitForReview(projectId, taskId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, taskId] });
      toast.success("Submitted for review");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
