import { useQuery } from "@tanstack/react-query";
import { taskService } from "@/features/tasks/services/taskService";

export function useMyTasks(filters = {}) {
  return useQuery({
    queryKey: ["tasks", "myTasks", filters],
    queryFn: () => taskService.listMy(filters),
  });
}
