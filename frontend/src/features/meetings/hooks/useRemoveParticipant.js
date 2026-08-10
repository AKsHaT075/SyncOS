import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useRemoveParticipant(projectId, meetingId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId) => meetingService.removeParticipant(projectId, meetingId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", "detail", projectId, meetingId] });
      toast.success("Participant removed");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
