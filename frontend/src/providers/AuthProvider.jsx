"use client";

import { useEffect, useRef } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { authService } from "@/features/auth/services/authService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const PUBLIC_AUTH_PATHS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
]);

export default function AuthProvider({ children }) {
  const hasBootstrapped = useRef(false);
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const setUser = useAuthStore((state) => state.setUser);
  const clearAuth = useAuthStore((state) => state.clearAuth);

  useEffect(() => {
    if (hasBootstrapped.current) {
      return;
    }

    hasBootstrapped.current = true;

    if (typeof window !== "undefined" && PUBLIC_AUTH_PATHS.has(window.location.pathname)) {
      useAuthStore.setState({ isLoading: false });
      return;
    }

    async function restoreSession() {
      try {
        const refreshData = await authService.refreshToken();
        if (refreshData?.accessToken) {
          setAccessToken(refreshData.accessToken);
        }

        const currentUserData = await authService.getCurrentUser();
        const user = currentUserData?.user || null;

        if (user) {
          setUser(user);
        }
      } catch (error) {
        clearAuth();
        if (process.env.NODE_ENV !== "production") {
          console.debug("Session restore failed:", getFriendlyErrorMessage(error));
        }
      } finally {
        useAuthStore.setState({ isLoading: false });
      }
    }

    restoreSession();
  }, [clearAuth, setAccessToken, setUser]);

  return children;
}
