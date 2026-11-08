import { api } from "@/lib/axios";

export const notificationService = {
  list: async (params) => (await api.get("/notifications", { params })).data,
  unreadCount: async () => (await api.get("/notifications/unread-count")).data,
  unreadByType: async () => (await api.get("/notifications/unread-by-type")).data,
  markTypesRead: async (types) => (await api.post("/notifications/read-all", { types })).data,
  markRead: async (id) => (await api.post(`/notifications/${id}/read`)).data,
  markAllRead: async (category) => (await api.post("/notifications/read-all", category ? { category } : {})).data,
  dismiss: async (id) => (await api.delete(`/notifications/${id}`)).data,
  getPreferences: async () => (await api.get("/notifications/preferences")).data,
  updatePreferences: async (updates) => (await api.put("/notifications/preferences", updates)).data,
  // EventSource can't set headers; it authenticates with the HTTP-only cookie.
  streamUrl: () => `${api.defaults.baseURL}/notifications/stream`,
};
