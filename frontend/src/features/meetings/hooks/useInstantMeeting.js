import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useInstantMeeting(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => meetingService.instant(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["meetings", "mine"] });
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
