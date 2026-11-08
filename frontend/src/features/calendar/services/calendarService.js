import { api } from "@/lib/axios";

export const calendarService = {
  list: async (params) => (await api.get("/calendar", { params })).data,
  getEvent: async (id) => (await api.get(`/calendar/events/${id}`)).data,
  createEvent: async (body) => (await api.post("/calendar/events", body)).data,
  updateEvent: async (id, body) => (await api.patch(`/calendar/events/${id}`, body)).data,
  deleteEvent: async (id, params) => (await api.delete(`/calendar/events/${id}`, { params })).data,
  rsvp: async (id, status) => (await api.post(`/calendar/events/${id}/rsvp`, { status })).data,
  getPreferences: async () => (await api.get("/calendar/preferences")).data,
  updatePreferences: async (updates) => (await api.put("/calendar/preferences", updates)).data,
};
