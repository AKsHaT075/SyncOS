import { api } from "@/lib/axios";

export const projectResourceService = {
  list: async (projectId) => {
    const response = await api.get(`/projects/${projectId}/resources`);
    return response.data;
  },
  upload: async (projectId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await api.post(`/projects/${projectId}/resources`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
  },
  remove: async (projectId, resourceId) => {
    const response = await api.delete(`/projects/${projectId}/resources/${resourceId}`);
    return response.data;
  },
  downloadUrl: (projectId, resourceId) => {
    const baseURL = api.defaults.baseURL || "";
    return `${baseURL}/projects/${projectId}/resources/${resourceId}/download`;
  },
};
