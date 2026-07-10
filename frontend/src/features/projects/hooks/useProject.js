import { useQuery } from "@tanstack/react-query";
import { projectService } from "@/features/projects/services/projectService";

export function useProject(projectId) {
  return useQuery({
    queryKey: ["projects", "detail", projectId],
    queryFn: () => projectService.get(projectId),
    enabled: Boolean(projectId),
  });
}
