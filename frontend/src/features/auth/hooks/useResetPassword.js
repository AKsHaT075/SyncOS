import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useResetPassword() {
  return useMutation({
    mutationFn: authService.resetPassword,
    onSuccess: () => {
      toast.success("Password reset successfully");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
