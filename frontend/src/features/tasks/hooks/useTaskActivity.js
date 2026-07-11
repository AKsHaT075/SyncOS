import { useQuery } from "@tanstack/react-query";
import { taskService } from "@/features/tasks/services/taskService";

export function useTaskActivity(projectId, taskId, params = {}) {
  return useQuery({
    queryKey: ["tasks", "activity", projectId, taskId, params],
    queryFn: () => taskService.getActivity(projectId, taskId, params),
    enabled: Boolean(projectId) && Boolean(taskId),
  });
}
