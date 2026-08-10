import { useQuery } from "@tanstack/react-query";
import { meetingService } from "@/features/meetings/services/meetingService";

const TERMINAL_STATUSES = new Set(["Ended", "Cancelled"]);

export function useMeeting(projectId, meetingId) {
  return useQuery({
    queryKey: ["meetings", "detail", projectId, meetingId],
    queryFn: () => meetingService.get(projectId, meetingId),
    enabled: Boolean(projectId) && Boolean(meetingId),
    // A meeting's status/participants change from outside this tab entirely
    // (someone else joins → Active, the LiveKit webhook marks it Ended) —
    // poll while it's still "live" so the detail page (Join button, status
    // badge, participant list) reflects that without a manual refresh. Once
    // it's Ended/Cancelled nothing more will change, so stop polling.
    refetchInterval: (query) => {
      const status = query.state.data?.meeting?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : 8000;
    },
  });
}
