import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectService } from "@/features/projects/services/projectService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUpdateProject(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => projectService.update(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
