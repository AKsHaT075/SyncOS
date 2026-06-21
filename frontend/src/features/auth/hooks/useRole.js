import { useAuthStore } from "@/store/useAuthStore";

export function useRole() {
  return useAuthStore((state) => state.role);
}
