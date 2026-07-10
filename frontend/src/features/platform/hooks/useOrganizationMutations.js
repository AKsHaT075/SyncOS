import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { platformService } from "@/features/platform/services/platformService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

function useOrgMutation(mutationFn, successMessage) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-organizations"] });
      toast.success(successMessage);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useUpdateOrganizationPlan() {
  return useOrgMutation(
    ({ organizationId, plan }) => platformService.updatePlan(organizationId, plan),
    "Plan updated"
  );
}

export function useSuspendOrganization() {
  return useOrgMutation(
    ({ organizationId, reason }) => platformService.suspend(organizationId, reason),
    "Organization suspended"
  );
}

export function useReactivateOrganization() {
  return useOrgMutation(
    ({ organizationId }) => platformService.reactivate(organizationId),
    "Organization reactivated"
  );
}

export function useUpdateFeatureFlags() {
  return useOrgMutation(
    ({ organizationId, featureFlags }) => platformService.updateFeatureFlags(organizationId, featureFlags),
    "Feature flags updated"
  );
}
