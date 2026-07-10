import { useQuery } from "@tanstack/react-query";
import { invitationService } from "@/features/invitations/services/invitationService";
import { useAuthStore } from "@/store/useAuthStore";
import { ROLES } from "@/constants/roles";

export function usePendingInvitations({ limit = 5 } = {}) {
  const canViewInvitations = useAuthStore(
    (state) => state.user?.role === ROLES.ORG_ADMIN || state.user?.role === ROLES.ADMIN
  );

  return useQuery({
    queryKey: ["invitations", "pending", limit],
    queryFn: () => invitationService.list({ status: "pending", limit }),
    enabled: canViewInvitations,
  });
}
