import { useQuery } from "@tanstack/react-query";
import { meetingService } from "@/features/meetings/services/meetingService";

export function useMeetings(projectId, filters = {}) {
  return useQuery({
    queryKey: ["meetings", "list", projectId, filters],
    queryFn: () => meetingService.list(projectId, filters),
    enabled: Boolean(projectId),
    // Light polling so the list picks up status changes (someone starts an
    // instant meeting, a scheduled one goes Active) without a manual reload.
    refetchInterval: 20000,
  });
}
