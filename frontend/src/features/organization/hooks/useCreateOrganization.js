import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizationService } from "@/features/organization/services/organizationService";
import { authService } from "@/features/auth/services/authService";
import { useAuthStore } from "@/store/useAuthStore";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useCreateOrganization() {
  const setUser = useAuthStore((state) => state.setUser);
  const setOrganizationDetails = useAuthStore((state) => state.setOrganizationDetails);

  return useMutation({
    mutationFn: (payload) =>
      organizationService.create({
        name: payload.name,
        slug: payload.slug || undefined,
        logo: payload.logo || undefined,
      }),
    onSuccess: async (data) => {
      const { user } = await authService.getCurrentUser();
      setUser(user);
      setOrganizationDetails(data.organization);
      toast.success(`${data.organization.name} is ready`);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
