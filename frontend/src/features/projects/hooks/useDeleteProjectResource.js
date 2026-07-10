import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectResourceService } from "@/features/projects/services/projectResourceService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useDeleteProjectResource(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (resourceId) => projectResourceService.remove(projectId, resourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", "detail", projectId, "resources"] });
      toast.success("File removed");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}
