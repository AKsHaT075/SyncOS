import { api } from "@/lib/axios";

export const taskService = {
  listMy: async (params = {}) => {
    const response = await api.get(`/tasks`, { params });
    return response.data;
  },
  list: async (projectId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/tasks`, { params });
    return response.data;
  },
  get: async (projectId, taskId) => {
    const response = await api.get(`/projects/${projectId}/tasks/${taskId}`);
    return response.data;
  },
  create: async (projectId, payload) => {
    const response = await api.post(`/projects/${projectId}/tasks`, payload);
    return response.data;
  },
  update: async (projectId, taskId, payload) => {
    const response = await api.patch(`/projects/${projectId}/tasks/${taskId}`, payload);
    return response.data;
  },
  remove: async (projectId, taskId) => {
    const response = await api.delete(`/projects/${projectId}/tasks/${taskId}`);
    return response.data;
  },
  archive: async (projectId, taskId) => {
    const response = await api.post(`/projects/${projectId}/tasks/${taskId}/archive`);
    return response.data;
  },
  unarchive: async (projectId, taskId) => {
    const response = await api.post(`/projects/${projectId}/tasks/${taskId}/unarchive`);
    return response.data;
  },
  submitForReview: async (projectId, taskId, { description, files }) => {
    const formData = new FormData();
    formData.append("description", description);
    (files || []).forEach((file) => formData.append("files", file));
    const response = await api.post(`/projects/${projectId}/tasks/${taskId}/submit`, formData);
    return response.data;
  },
  review: async (projectId, taskId, payload) => {
    const response = await api.post(`/projects/${projectId}/tasks/${taskId}/review`, payload);
    return response.data;
  },
  getActivity: async (projectId, taskId, params = {}) => {
    const response = await api.get(`/projects/${projectId}/tasks/${taskId}/activity`, { params });
    return response.data;
  },
  uploadAttachment: async (projectId, taskId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await api.post(`/projects/${projectId}/tasks/${taskId}/attachments`, formData);
    return response.data;
  },
  removeAttachment: async (projectId, taskId, attachmentId) => {
    const response = await api.delete(`/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`);
    return response.data;
  },
  attachmentDownloadUrl: (projectId, taskId, attachmentId) =>
    `${api.defaults.baseURL}/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/download`,
};
