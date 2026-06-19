import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { useAuthStore } from "@/store/useAuthStore";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useLogin() {
  const login = useAuthStore((state) => state.login);

  return useMutation({
    mutationFn: authService.login,
    onSuccess: (data) => {
      login(data.user, data.accessToken);
      toast.success("Signed in successfully");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
