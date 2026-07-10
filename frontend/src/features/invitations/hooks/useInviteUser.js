import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invitationService } from "@/features/invitations/services/invitationService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useInviteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) => invitationService.invite(payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success(`Invite sent to ${variables.email}`);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
