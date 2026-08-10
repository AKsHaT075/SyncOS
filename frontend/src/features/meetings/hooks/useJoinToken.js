import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { meetingService } from "@/features/meetings/services/meetingService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

// Not cached as a query — every call to the Meeting Room should mint a fresh
// token rather than risk handing back a stale/expired one.
export function useJoinToken(projectId, meetingId) {
  return useMutation({
    mutationFn: () => meetingService.getJoinToken(projectId, meetingId),
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
