import { useAuthStore } from "@/store/useAuthStore";

export function usePermission(permission) {
  return useAuthStore((state) => state.permissions.includes(permission));
}
