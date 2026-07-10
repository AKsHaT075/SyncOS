import { useQuery } from "@tanstack/react-query";
import { projectService } from "@/features/projects/services/projectService";

export function useProjectMemberCandidates(projectId, search, enabled = true) {
  return useQuery({
    queryKey: ["projects", "detail", projectId, "member-candidates", search],
    queryFn: () => projectService.getMemberCandidates(projectId, { search: search || undefined }),
    enabled: Boolean(projectId) && enabled,
  });
}
