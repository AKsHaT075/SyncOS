import { api } from "@/lib/axios";

export const projectService = {
  list: async (params = {}) => {
    const response = await api.get("/projects", { params });
    return response.data;
  },
  get: async (projectId) => {
    const response = await api.get(`/projects/${projectId}`);
    return response.data;
  },
  create: async (payload) => {
    const response = await api.post("/projects", payload);
    return response.data;
  },
  update: async (projectId, payload) => {
    const response = await api.patch(`/projects/${projectId}`, payload);
    return response.data;
  },
  archive: async (projectId) => {
    const response = await api.post(`/projects/${projectId}/archive`);
    return response.data;
  },
  restore: async (projectId) => {
    const response = await api.post(`/projects/${projectId}/restore`);
    return response.data;
  },
  remove: async (projectId) => {
    const response = await api.delete(`/projects/${projectId}`);
    return response.data;
  },
  favorite: async (projectId) => {
    const response = await api.post(`/projects/${projectId}/favorite`);
    return response.data;
  },
  unfavorite: async (projectId) => {
    const response = await api.delete(`/projects/${projectId}/favorite`);
    return response.data;
  },
  addMember: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/members`, payload);
    return response.data;
  },
  updateMemberRole: async (projectId, userId, role) => {
    const response = await api.patch(`/projects/${projectId}/members/${userId}`, { role });
    return response.data;
  },
  removeMember: async (projectId, userId) => {
    const response = await api.delete(`/projects/${projectId}/members/${userId}`);
    return response.data;
  },
  getMemberCandidates: async (projectId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/members/candidates`, { params });
    return response.data;
  },
  getActivity: async (projectId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/activity`, { params });
    return response.data;
  },
  transferOwnership: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/transfer-ownership`, payload);
    return response.data;
  },
};
