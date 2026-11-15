import { api } from "@/lib/axios";

export const accountService = {
  updateProfile: async (payload) => (await api.patch("/auth/me", payload)).data,
  changePassword: async (payload) => (await api.post("/auth/change-password", payload)).data,
  updateOrganization: async (payload) => (await api.patch("/organizations/me", payload)).data,
  getOrganizationUsage: async () => (await api.get("/organizations/me/usage")).data,
};
