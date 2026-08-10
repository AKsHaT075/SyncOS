import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingRequestService } from "@/features/meetingRequests/services/meetingRequestService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

// One hook covers all three decision actions — same invalidation/toast
// shape, only the underlying service call and success copy differ.
function useDecision(projectId, action, successMessage) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ requestId, payload }) => action(projectId, requestId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetingRequests", "list", projectId] });
      queryClient.invalidateQueries({ queryKey: ["meetings", "list", projectId] });
      toast.success(successMessage);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useApproveMeetingRequest(projectId) {
  return useDecision(projectId, meetingRequestService.approve, "Meeting request approved");
}

export function useRejectMeetingRequest(projectId) {
  return useDecision(projectId, meetingRequestService.reject, "Meeting request rejected");
}

export function useScheduleMeetingRequest(projectId) {
  return useDecision(projectId, meetingRequestService.schedule, "Meeting scheduled from request");
}
