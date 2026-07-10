import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { useAuthStore } from "@/store/useAuthStore";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useUpdateStatus() {
  const setUser = useAuthStore((state) => state.setUser);

  return useMutation({
    mutationFn: (status) => authService.updateStatus(status),
    onSuccess: (data) => {
      if (data?.user) {
        setUser(data.user);
      }
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
