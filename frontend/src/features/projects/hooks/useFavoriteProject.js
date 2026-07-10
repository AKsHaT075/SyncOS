import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectService } from "@/features/projects/services/projectService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useFavoriteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, isFavorite }) =>
      isFavorite ? projectService.unfavorite(projectId) : projectService.favorite(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
