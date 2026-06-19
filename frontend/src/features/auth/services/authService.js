import { api, refreshClient } from "@/lib/axios";

export const authService = {
  forgotPassword: async (payload) => {
    const response = await api.post("/auth/forgot-password", payload);
    return response.data;
  },
  getCurrentUser: async () => {
    const response = await api.get("/auth/me");
    return response.data;
  },
  login: async (payload) => {
    const response = await api.post("/auth/login", payload);
    return response.data;
  },
  logout: async () => {
    const response = await api.post("/auth/logout");
    return response.data;
  },
  logoutAllDevices: async () => {
    const response = await api.post("/auth/logout-all");
    return response.data;
  },
  refreshToken: async () => {
    const response = await refreshClient.post("/auth/refresh");
    return response.data;
  },
  register: async (payload) => {
    const response = await api.post("/auth/register", payload);
    return response.data;
  },
  resetPassword: async (payload) => {
    const response = await api.post("/auth/reset-password", payload);
    return response.data;
  },
  verifyEmail: async (payload) => {
    const response = await api.post("/auth/verify-email", payload);
    return response.data;
  },
};
