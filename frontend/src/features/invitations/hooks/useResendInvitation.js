import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invitationService } from "@/features/invitations/services/invitationService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useResendInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invitationId) => invitationService.resend(invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success("Invite resent");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
