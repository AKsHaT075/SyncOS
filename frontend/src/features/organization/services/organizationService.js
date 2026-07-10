import { api } from "@/lib/axios";

export function extractInviteToken(input) {
  const value = input.trim();

  try {
    const url = new URL(value);
    return url.searchParams.get("token") || value;
  } catch {
    return value;
  }
}

export const organizationService = {
  create: async (payload) => {
    const response = await api.post("/organizations", payload);
    return response.data;
  },
  getMyOrganizations: async () => {
    const response = await api.get("/organizations/me");
    return response.data;
  },
  joinByInvite: async (token) => {
    const response = await api.post("/invitations/accept-existing", { token });
    return response.data;
  },
};
