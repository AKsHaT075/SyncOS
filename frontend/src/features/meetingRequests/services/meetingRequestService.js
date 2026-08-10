import { api } from "@/lib/axios";

export const meetingRequestService = {
  list: async (projectId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/meeting-requests`, { params });
    return response.data;
  },
  create: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/meeting-requests`, payload);
    return response.data;
  },
  approve: async (projectId, requestId, payload = {}) => {
    const response = await api.post(`/projects/${projectId}/meeting-requests/${requestId}/approve`, payload);
    return response.data;
  },
  reject: async (projectId, requestId, payload = {}) => {
    const response = await api.post(`/projects/${projectId}/meeting-requests/${requestId}/reject`, payload);
    return response.data;
  },
  schedule: async (projectId, requestId, payload) => {
    const response = await api.post(`/projects/${projectId}/meeting-requests/${requestId}/schedule`, payload);
    return response.data;
  },
};
