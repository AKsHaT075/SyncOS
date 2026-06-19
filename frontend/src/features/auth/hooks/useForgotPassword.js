import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useForgotPassword() {
  return useMutation({
    mutationFn: authService.forgotPassword,
    onSuccess: () => {
      toast.success("If the account exists, a reset link has been sent.");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
