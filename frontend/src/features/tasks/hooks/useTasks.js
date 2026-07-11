import { useQuery } from "@tanstack/react-query";
import { taskService } from "@/features/tasks/services/taskService";

export function useTasks(projectId, filters = {}) {
  return useQuery({
    queryKey: ["tasks", "list", projectId, filters],
    queryFn: () => taskService.list(projectId, filters),
    enabled: Boolean(projectId),
  });
}
