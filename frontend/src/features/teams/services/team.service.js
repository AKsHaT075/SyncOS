import { api } from "@/lib/axios";

export const teamService = {
  listTeams: async (query) => {
    const response = await api.get("/teams", { params: query });
    return response.data;
  },

  getMyTeam: async () => {
    const response = await api.get("/teams/me");
    return response.data;
  },

  createTeam: async (data) => {
    const response = await api.post("/teams", data);
    return response.data;
  },

  getTeam: async (teamId) => {
    const response = await api.get(`/teams/${teamId}`);
    return response.data;
  },

  updateTeam: async (teamId, updates) => {
    const response = await api.patch(`/teams/${teamId}`, updates);
    return response.data;
  },

  deleteTeam: async (teamId) => {
    const response = await api.delete(`/teams/${teamId}`);
    return response.data;
  },

  addMember: async (teamId, userId) => {
    const response = await api.post(`/teams/${teamId}/members`, { userId });
    return response.data;
  },

  removeMember: async (teamId, userId) => {
    const response = await api.delete(`/teams/${teamId}/members/${userId}`);
    return response.data;
  },

  setManager: async (teamId, userId) => {
    const response = await api.put(`/teams/${teamId}/manager`, { userId });
    return response.data;
  },

  listMemberCandidates: async (teamId, search, role) => {
    const response = await api.get(`/teams/${teamId}/member-candidates`, { params: { search, role } });
    return response.data;
  },
};
