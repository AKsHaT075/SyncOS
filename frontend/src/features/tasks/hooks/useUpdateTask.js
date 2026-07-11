import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskService } from "@/features/tasks/services/taskService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

// taskId travels with each mutate() call (not bound at hook creation) so a
// single hook instance can drive updates for many tasks at once — e.g. the
// Kanban board, where every card shares one mutation.
export function useUpdateTask(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, ...payload }) => taskService.update(projectId, taskId, payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", projectId, variables.taskId] });
      toast.success("Task updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
