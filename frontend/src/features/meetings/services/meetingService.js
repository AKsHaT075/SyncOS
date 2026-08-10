import { api } from "@/lib/axios";

export const meetingService = {
  listMy: async (params = {}) => {
    const response = await api.get(`/meetings`, { params });
    return response.data;
  },
  list: async (projectId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/meetings`, { params });
    return response.data;
  },
  get: async (projectId, meetingId) => {
    const response = await api.get(`/projects/${projectId}/meetings/${meetingId}`);
    return response.data;
  },
  schedule: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/meetings`, payload);
    return response.data;
  },
  instant: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/meetings/instant`, payload);
    return response.data;
  },
  update: async (projectId, meetingId, payload) => {
    const response = await api.patch(`/projects/${projectId}/meetings/${meetingId}`, payload);
    return response.data;
  },
  cancel: async (projectId, meetingId) => {
    const response = await api.post(`/projects/${projectId}/meetings/${meetingId}/cancel`);
    return response.data;
  },
  end: async (projectId, meetingId) => {
    const response = await api.post(`/projects/${projectId}/meetings/${meetingId}/end`);
    return response.data;
  },
  addParticipants: async (projectId, meetingId, participants) => {
    const response = await api.post(`/projects/${projectId}/meetings/${meetingId}/participants`, { participants });
    return response.data;
  },
  removeParticipant: async (projectId, meetingId, userId) => {
    const response = await api.delete(`/projects/${projectId}/meetings/${meetingId}/participants/${userId}`);
    return response.data;
  },
  kickParticipant: async (projectId, meetingId, userId) => {
    const response = await api.post(`/projects/${projectId}/meetings/${meetingId}/room-participants/${userId}/kick`);
    return response.data;
  },
  getJoinToken: async (projectId, meetingId) => {
    const response = await api.post(`/projects/${projectId}/meetings/${meetingId}/token`);
    return response.data;
  },
  getActivity: async (projectId, meetingId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/meetings/${meetingId}/activity`, { params });
    return response.data;
  },
};
