import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectService } from "@/features/projects/services/projectService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useTransferOwnership(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => projectService.transferOwnership(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", "detail", projectId] });
      toast.success("Ownership transferred");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}
