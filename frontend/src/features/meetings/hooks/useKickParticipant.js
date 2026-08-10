import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useKickParticipant(projectId, meetingId) {
  return useMutation({
    mutationFn: (userId) => meetingService.kickParticipant(projectId, meetingId, userId),
    onSuccess: () => {
      toast.success("Removed from the call");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
