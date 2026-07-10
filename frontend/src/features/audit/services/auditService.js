import { api } from "@/lib/axios";

export const auditService = {
  list: async (params = {}) => {
    const response = await api.get("/audit-logs", { params });
    return response.data;
  },
};
