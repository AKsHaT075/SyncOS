import { useQuery } from "@tanstack/react-query";
import { taskService } from "@/features/tasks/services/taskService";

export function useTask(projectId, taskId) {
  return useQuery({
    queryKey: ["tasks", "detail", projectId, taskId],
    queryFn: () => taskService.get(projectId, taskId),
    enabled: Boolean(projectId) && Boolean(taskId),
  });
}
