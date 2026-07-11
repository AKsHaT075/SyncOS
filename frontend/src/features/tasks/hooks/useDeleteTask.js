import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useDeleteTask(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId) => taskService.remove(projectId, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      toast.success("Task deleted");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
