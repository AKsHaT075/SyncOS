import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUpdateMeeting(projectId, meetingId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => meetingService.update(projectId, meetingId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", "detail", projectId, meetingId] });
      queryClient.invalidateQueries({ queryKey: ["meetings", "list", projectId] });
      toast.success("Meeting updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
