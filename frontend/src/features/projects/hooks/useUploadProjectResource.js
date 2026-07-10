import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectResourceService } from "@/features/projects/services/projectResourceService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUploadProjectResource(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file) => projectResourceService.upload(projectId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", "detail", projectId, "resources"] });
      toast.success("File uploaded");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}
