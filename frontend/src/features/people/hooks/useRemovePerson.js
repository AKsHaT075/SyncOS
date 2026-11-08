import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { peopleService } from "@/features/people/services/people.service";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useRemovePerson() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId) => peopleService.removePerson(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("User removed from the organization");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
