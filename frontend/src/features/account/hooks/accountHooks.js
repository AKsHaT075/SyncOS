import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { accountService } from "@/features/account/services/accountService";
import { getFriendlyErrorMessage } from "@/lib/error-message";
import { useAuthStore } from "@/store/useAuthStore";

export function useUpdateProfile() {
  const setUser = useAuthStore((state) => state.setUser);
  return useMutation({
    mutationFn: accountService.updateProfile,
    onSuccess: ({ user }) => {
      setUser(user);
      toast.success("Profile updated");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

/** The server signs every session out after a password change, so this ends the local session too. */
export function useChangePassword() {
  const logout = useAuthStore((state) => state.logout);
  const router = useRouter();
  return useMutation({
    mutationFn: accountService.changePassword,
    onSuccess: () => {
      logout();
      toast.success("Password changed. Please sign in again.");
      router.replace("/login");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export function useUpdateOrganization() {
  const setOrganizationDetails = useAuthStore((state) => state.setOrganizationDetails);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: accountService.updateOrganization,
    onSuccess: ({ organization }) => {
      setOrganizationDetails(organization);
      queryClient.invalidateQueries({ queryKey: ["organization-usage"] });
      toast.success("Organization updated");
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export const useOrganizationUsage = ({ enabled = true } = {}) =>
  useQuery({ queryKey: ["organization-usage"], queryFn: async () => (await accountService.getOrganizationUsage()).usage, enabled, staleTime: 30_000 });
