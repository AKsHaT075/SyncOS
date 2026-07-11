import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUnarchiveTask(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId) => taskService.unarchive(projectId, taskId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, data.task.id] });
      toast.success("Task unarchived");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
