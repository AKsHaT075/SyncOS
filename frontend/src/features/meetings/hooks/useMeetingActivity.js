import { useQuery } from "@tanstack/react-query";
import { meetingService } from "@/features/meetings/services/meetingService";

export function useMeetingActivity(projectId, meetingId, params = {}) {
  return useQuery({
    queryKey: ["meetings", "activity", projectId, meetingId, params],
    queryFn: () => meetingService.getActivity(projectId, meetingId, params),
    enabled: Boolean(projectId) && Boolean(meetingId),
  });
}
