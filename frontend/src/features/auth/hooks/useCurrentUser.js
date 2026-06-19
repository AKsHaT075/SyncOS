import { useQuery } from "@tanstack/react-query";
import { authService } from "@/features/auth/services/authService";

export function useCurrentUser(options = {}) {
  return useQuery({
    queryFn: authService.getCurrentUser,
    queryKey: ["auth", "current-user"],
    retry: false,
    staleTime: 60 * 1000,
    ...options,
  });
}
