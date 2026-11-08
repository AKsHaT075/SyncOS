import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { peopleService } from "@/features/people/services/people.service";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUpdatePerson(userId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (updates) => peopleService.updatePerson(userId, updates),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["people", "list"] });
      queryClient.invalidateQueries({ queryKey: ["people", "detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("User profile updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
