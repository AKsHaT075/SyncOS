import { useQuery } from "@tanstack/react-query";
import { peopleService } from "@/features/people/services/people.service";

export function usePerson(userId) {
  return useQuery({
    queryKey: ["people", "detail", userId],
    queryFn: () => peopleService.getPerson(userId),
    enabled: !!userId,
  });
}
