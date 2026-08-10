import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useScheduleMeeting(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => meetingService.schedule(projectId, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["meetings", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["meetings", "mine"] });
      toast.success(`"${data.meeting.topic}" scheduled`);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
