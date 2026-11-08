import { useQuery } from "@tanstack/react-query";
import { peopleService } from "@/features/people/services/people.service";

export function usePeople(filters = {}) {
  return useQuery({
    queryKey: ["people", "list", filters],
    queryFn: () => peopleService.listPeople(filters),
  });
}
