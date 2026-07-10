import { useQuery } from "@tanstack/react-query";
import { auditService } from "@/features/audit/services/auditService";
import { useAuthStore } from "@/store/useAuthStore";
import { ROLES } from "@/constants/roles";

export function useRecentActivity({ limit = 6 } = {}) {
  const canViewAuditLogs = useAuthStore(
    (state) => state.user?.role === ROLES.ORG_ADMIN || state.user?.role === ROLES.ADMIN
  );

  return useQuery({
    queryKey: ["audit-logs", "recent", limit],
    queryFn: () => auditService.list({ limit }),
    enabled: canViewAuditLogs,
  });
}
