import { useQuery } from "@tanstack/react-query";
import { platformService } from "@/features/platform/services/platformService";
import { useAuthStore } from "@/store/useAuthStore";
import { ROLES } from "@/constants/roles";

export function useOrganizations({ limit = 50 } = {}) {
  const isSuperAdmin = useAuthStore((state) => state.user?.role === ROLES.SUPER_ADMIN);

  return useQuery({
    queryKey: ["platform-organizations", limit],
    queryFn: () => platformService.listOrganizations({ limit }),
    enabled: isSuperAdmin,
  });
}
