import { useQuery } from "@tanstack/react-query";
import { meetingService } from "@/features/meetings/services/meetingService";

export function useMyMeetings(filters = {}) {
  return useQuery({
    queryKey: ["meetings", "mine", filters],
    queryFn: () => meetingService.listMy(filters),
    // Light polling so status changes across projects show up without a
    // manual reload — same reasoning as useMeetings.
    refetchInterval: 20000,
  });
}
