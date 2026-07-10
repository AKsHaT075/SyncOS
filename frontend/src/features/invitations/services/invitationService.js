import { api } from "@/lib/axios";

export const invitationService = {
  list: async (params = {}) => {
    const response = await api.get("/invitations", { params });
    return response.data;
  },
  invite: async (payload) => {
    const response = await api.post("/invitations", payload);
    return response.data;
  },
  resend: async (invitationId) => {
    const response = await api.post(`/invitations/${invitationId}/resend`);
    return response.data;
  },
  revoke: async (invitationId) => {
    const response = await api.post(`/invitations/${invitationId}/revoke`);
    return response.data;
  },
};
