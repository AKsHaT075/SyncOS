import { useQuery } from "@tanstack/react-query";
import { projectService } from "@/features/projects/services/projectService";

export function useProjects(filters = {}) {
  return useQuery({
    queryKey: ["projects", "list", filters],
    queryFn: () => projectService.list(filters),
  });
}
