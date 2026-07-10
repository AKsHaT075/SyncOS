import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectService } from "@/features/projects/services/projectService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

function useInvalidateProject(projectId) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["projects", "detail", projectId] });
}

export function useAddProjectMember(projectId) {
  const invalidate = useInvalidateProject(projectId);

  return useMutation({
    mutationFn: (payload) => projectService.addMember(projectId, payload),
    onSuccess: () => {
      invalidate();
      toast.success("Member added");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export function useUpdateProjectMemberRole(projectId) {
  const invalidate = useInvalidateProject(projectId);

  return useMutation({
    mutationFn: ({ userId, role }) => projectService.updateMemberRole(projectId, userId, role),
    onSuccess: () => {
      invalidate();
      toast.success("Member role updated");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export function useRemoveProjectMember(projectId) {
  const invalidate = useInvalidateProject(projectId);

  return useMutation({
    mutationFn: (userId) => projectService.removeMember(projectId, userId),
    onSuccess: () => {
      invalidate();
      toast.success("Member removed");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}
