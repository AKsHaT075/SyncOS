import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useRegister() {
  return useMutation({
    mutationFn: authService.register,
    onSuccess: () => {
      toast.success("Account created. Check your email for the OTP.");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
