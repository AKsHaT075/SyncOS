import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { assetService } from "@/features/assets/services/assetService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const KEY = "assets";

export const useAssets = (params) =>
  useQuery({ queryKey: [KEY, "list", params], queryFn: () => assetService.list(params), placeholderData: keepPreviousData });
export const useAsset = (id) => useQuery({ queryKey: [KEY, "detail", id], queryFn: () => assetService.get(id), enabled: !!id });
export const useAssetOptions = () => useQuery({ queryKey: [KEY, "options"], queryFn: assetService.options });
export const useAssetSummary = () => useQuery({ queryKey: [KEY, "summary"], queryFn: assetService.summary });
export const useMyAssets = () => useQuery({ queryKey: [KEY, "mine"], queryFn: assetService.mine });
export const useOffboarding = (enabled = true) => useQuery({ queryKey: [KEY, "offboarding"], queryFn: assetService.offboarding, enabled });
export const useAssetHistory = (id, params) =>
  useQuery({ queryKey: [KEY, "history", id, params], queryFn: () => assetService.history(id, params), enabled: !!id, placeholderData: keepPreviousData });
export const useAssetActivity = (id, params, enabled = true) =>
  useQuery({ queryKey: [KEY, "activity", id, params], queryFn: () => assetService.activity(id, params), enabled: !!id && enabled, placeholderData: keepPreviousData });
export const useAssignments = (params) =>
  useQuery({ queryKey: [KEY, "assignments", params], queryFn: () => assetService.assignments(params), placeholderData: keepPreviousData });
export const useMaintenanceList = (params) =>
  useQuery({ queryKey: [KEY, "maintenance", "all", params], queryFn: () => assetService.maintenance(params), placeholderData: keepPreviousData });
export const useAssetMaintenance = (id) =>
  useQuery({ queryKey: [KEY, "maintenance", id], queryFn: () => assetService.assetMaintenance(id), enabled: !!id });
export const useAssetDocuments = (id) =>
  useQuery({ queryKey: [KEY, "documents", id], queryFn: () => assetService.documents(id), enabled: !!id });
export const useCategories = (params) => useQuery({ queryKey: [KEY, "categories", params], queryFn: () => assetService.categories(params) });
export const useVendors = (params) => useQuery({ queryKey: [KEY, "vendors", params], queryFn: () => assetService.vendors(params) });

// Assets, assignments, maintenance and reports all derive from the same records, so any change refreshes the
// whole module (it is small per view). Notifications are refreshed too: actions create them server-side.
function useAssetMutation(mutationFn, { success, onSuccess } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: [KEY] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      const message = typeof success === "function" ? success(data, variables) : success;
      if (message) toast.success(message);
      onSuccess?.(data, variables);
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export const useCreateAsset = () => useAssetMutation(assetService.create, { success: (data) => `${data.asset.name} added to inventory` });
export const useUpdateAsset = () => useAssetMutation(({ id, updates }) => assetService.update(id, updates), { success: "Asset updated" });
export const useArchiveAsset = () => useAssetMutation(assetService.archive, { success: "Asset archived" });
export const useRestoreAsset = () => useAssetMutation(assetService.restore, { success: "Asset restored" });

const ACTION_MESSAGES = {
  assign: "Asset assigned",
  transfer: "Asset transferred",
  return: "Return recorded",
  "request-return": "Return requested — the holder was notified",
  reserve: "Asset reserved",
  release: "Reservation released",
  retire: "Asset retired",
  dispose: "Asset marked as disposed",
  lost: "Asset marked as lost",
  found: "Asset marked as found",
};
export const useAssetAction = () =>
  useAssetMutation(({ id, action, payload }) => assetService.act(id, action, payload), { success: (_data, { action }) => ACTION_MESSAGES[action] });

export const useReportIssue = () =>
  useAssetMutation(({ id, payload }) => assetService.reportIssue(id, payload), { success: "Issue reported — the asset team will review it" });
export const useCreateMaintenance = () =>
  useAssetMutation(({ id, payload }) => assetService.createMaintenance(id, payload), { success: "Maintenance scheduled" });
export const useUpdateMaintenance = () =>
  useAssetMutation(({ id, maintenanceId, payload }) => assetService.updateMaintenance(id, maintenanceId, payload), { success: "Maintenance updated" });
const MAINTENANCE_MESSAGES = { approve: "Request approved and scheduled", decline: "Request declined", start: "Maintenance started", complete: "Maintenance completed", cancel: "Maintenance cancelled" };
export const useMaintenanceAction = () =>
  useAssetMutation(({ id, maintenanceId, action, payload }) => assetService.maintenanceAction(id, maintenanceId, action, payload), {
    success: (_data, { action }) => MAINTENANCE_MESSAGES[action],
  });

export const useLinkDocument = () => useAssetMutation(({ id, payload }) => assetService.linkDocument(id, payload), { success: "Document linked" });
export const useUnlinkDocument = () => useAssetMutation(({ id, linkId }) => assetService.unlinkDocument(id, linkId), { success: "Document unlinked" });

export const useCreateCategory = () => useAssetMutation(assetService.createCategory, { success: "Category created" });
export const useUpdateCategory = () => useAssetMutation(({ id, payload }) => assetService.updateCategory(id, payload), { success: "Category updated" });
export const useArchiveCategory = () =>
  useAssetMutation(({ id, payload }) => assetService.archiveCategory(id, payload), { success: (data) => (data.moved ? `Category archived — ${data.moved} asset(s) moved` : "Category archived") });
export const useCreateVendor = () => useAssetMutation(assetService.createVendor, { success: "Vendor added" });
export const useUpdateVendor = () => useAssetMutation(({ id, payload }) => assetService.updateVendor(id, payload), { success: "Vendor updated" });
export const useRemoveVendor = () => useAssetMutation(assetService.removeVendor, { success: "Vendor removed" });
