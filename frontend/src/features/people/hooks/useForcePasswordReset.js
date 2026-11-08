import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { peopleService } from "@/features/people/services/people.service";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useForcePasswordReset() {
  return useMutation({
    mutationFn: (userId) => peopleService.forcePasswordReset(userId),
    onSuccess: () => {
      toast.success("Sessions revoked and a password reset email was sent");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
