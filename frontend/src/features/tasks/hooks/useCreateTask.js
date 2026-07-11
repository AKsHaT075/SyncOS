import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useCreateTask(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => taskService.create(projectId, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      toast.success(`"${data.task.title}" created`);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
