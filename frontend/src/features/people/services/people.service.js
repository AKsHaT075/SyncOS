import { api } from "@/lib/axios";

export const peopleService = {
  listPeople: async (query) => {
    const response = await api.get("/people", { params: query });
    return response.data;
  },

  getPerson: async (userId) => {
    const response = await api.get(`/people/${userId}`);
    return response.data;
  },

  updatePerson: async (userId, updates) => {
    const response = await api.patch(`/people/${userId}`, updates);
    return response.data;
  },

  removePerson: async (userId) => {
    const response = await api.delete(`/people/${userId}`);
    return response.data;
  },

  forcePasswordReset: async (userId) => {
    const response = await api.post(`/people/${userId}/force-password-reset`);
    return response.data;
  },
};
