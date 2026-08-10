import { useQuery } from "@tanstack/react-query";
import { meetingRequestService } from "@/features/meetingRequests/services/meetingRequestService";

export function useMeetingRequests(projectId, filters = {}) {
  return useQuery({
    queryKey: ["meetingRequests", "list", projectId, filters],
    queryFn: () => meetingRequestService.list(projectId, filters),
    enabled: Boolean(projectId),
    // So a manager's decision (or a new request coming in) shows up for
    // anyone else with this page open without a manual reload.
    refetchInterval: 20000,
  });
}
