import { useQuery } from "@tanstack/react-query";
import { projectResourceService } from "@/features/projects/services/projectResourceService";

export function useProjectResources(projectId) {
  return useQuery({
    queryKey: ["projects", "detail", projectId, "resources"],
    queryFn: () => projectResourceService.list(projectId),
    enabled: Boolean(projectId),
  });
}
