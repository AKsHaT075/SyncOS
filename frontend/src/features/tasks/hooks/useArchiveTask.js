import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useArchiveTask(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId) => taskService.archive(projectId, taskId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, data.task.id] });
      toast.success("Task archived");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
