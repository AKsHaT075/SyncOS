import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const SUCCESS_MESSAGE = {
  Approved: "Reply sent — mark the task Completed when you're ready",
  Rejected: "Task rejected — back to In Progress",
  "Changes Requested": "Changes requested — back to In Progress",
};

export function useReviewTask(projectId, taskId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => taskService.review(projectId, taskId, payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, taskId] });
      toast.success(SUCCESS_MESSAGE[variables.action] || "Review recorded");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
