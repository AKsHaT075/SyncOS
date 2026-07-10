import { api } from "@/lib/axios";

export const platformService = {
  listOrganizations: async (params = {}) => {
    const response = await api.get("/platform/organizations", { params });
    return response.data;
  },
  updatePlan: async (organizationId, plan) => {
    const response = await api.patch(`/platform/organizations/${organizationId}/plan`, { plan });
    return response.data;
  },
  suspend: async (organizationId, reason) => {
    const response = await api.post(`/platform/organizations/${organizationId}/suspend`, { reason });
    return response.data;
  },
  reactivate: async (organizationId) => {
    const response = await api.post(`/platform/organizations/${organizationId}/reactivate`);
    return response.data;
  },
  updateFeatureFlags: async (organizationId, featureFlags) => {
    const response = await api.patch(`/platform/organizations/${organizationId}/feature-flags`, { featureFlags });
    return response.data;
  },
};
