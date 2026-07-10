import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizationService } from "@/features/organization/services/organizationService";
import { authService } from "@/features/auth/services/authService";
import { useAuthStore } from "@/store/useAuthStore";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useJoinOrganization() {
  const setUser = useAuthStore((state) => state.setUser);
  const setOrganizationDetails = useAuthStore((state) => state.setOrganizationDetails);

  return useMutation({
    mutationFn: (token) => organizationService.joinByInvite(token),
    onSuccess: async () => {
      const [{ user }, { organizations }] = await Promise.all([
        authService.getCurrentUser(),
        organizationService.getMyOrganizations(),
      ]);
      setUser(user);
      setOrganizationDetails(organizations[0] ?? null);
      toast.success("You've joined the organization");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
