import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingRequestService } from "@/features/meetingRequests/services/meetingRequestService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useCreateMeetingRequest(projectId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => meetingRequestService.create(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetingRequests", "list", projectId] });
      toast.success("Meeting request sent");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
