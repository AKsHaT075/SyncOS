import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authService } from "@/features/auth/services/authService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useVerifyEmail() {
  return useMutation({
    mutationFn: authService.verifyEmail,
    onSuccess: () => {
      toast.success("Email verified successfully");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}
