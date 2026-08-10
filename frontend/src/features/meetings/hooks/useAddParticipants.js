import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useAddParticipants(projectId, meetingId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (participants) => meetingService.addParticipants(projectId, meetingId, participants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", "detail", projectId, meetingId] });
      toast.success("Participants invited");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
