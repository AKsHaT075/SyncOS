import { useQuery } from "@tanstack/react-query";
import { projectService } from "@/features/projects/services/projectService";

export function useProjectActivity(projectId, params = {}) {
  return useQuery({
    queryKey: ["projects", "detail", projectId, "activity", params],
    queryFn: () => projectService.getActivity(projectId, params),
    enabled: Boolean(projectId),
  });
}
