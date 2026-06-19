import axios from "axios";
import { useAuthStore } from "@/store/useAuthStore";

const baseURL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api/v1";
const csrfCookieName = process.env.NEXT_PUBLIC_CSRF_COOKIE_NAME || "synapse_csrf_token";

function readCookie(name) {
  if (typeof document === "undefined") {
    return null;
  }

  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
});

export const api = axios.create({
  baseURL,
  withCredentials: true,
});

const refreshExemptPaths = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/verify-email",
  "/auth/resend-otp",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/auth/refresh",
  "/auth/csrf-token",
]);

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken) {
    config.headers["x-csrf-token"] = csrfToken;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error?.response?.status;
    const requestPath = originalRequest?.url || "";

    if (status !== 401 || originalRequest?._retry || [...refreshExemptPaths].some((path) => requestPath.includes(path))) {
      return Promise.reject(error);
    }

    if (originalRequest?._retry) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    try {
      const refreshResponse = await refreshClient.post("/auth/refresh");
      const { accessToken } = refreshResponse.data || {};

      if (!accessToken) {
        throw new Error("Missing access token from refresh response");
      }

      useAuthStore.getState().setAccessToken(accessToken);
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      useAuthStore.getState().clearAuth();

      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.assign("/login");
      }

      return Promise.reject(refreshError);
    }
  }
);

export function resetAuthHeaders() {
  delete api.defaults.headers.common.Authorization;
}
