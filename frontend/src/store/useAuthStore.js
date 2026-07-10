import { create } from "zustand";
import { persist } from "zustand/middleware";

const initialState = {
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
  user: null,
  role: null,
  permissions: [],
  organization: null,
  organizationDetails: null,
};

function deriveFromUser(user) {
  return {
    role: user?.role ?? null,
    permissions: user?.permissions ?? [],
    organization: user?.organization ?? null,
  };
}

function canUseLocalStorage() {
  if (typeof window === "undefined") return false;
  try {
    const test = "__storage_test__";
    window.localStorage.setItem(test, test);
    window.localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

export const useAuthStore = create(
  persist(
    (set) => ({
      ...initialState,
      clearAuth: () =>
        set({
          ...initialState,
          isLoading: false,
        }),
      login: (user, accessToken) =>
        set({
          accessToken,
          isAuthenticated: true,
          isLoading: false,
          user,
          ...deriveFromUser(user),
        }),
      logout: () =>
        set({
          ...initialState,
          isLoading: false,
        }),
      setAccessToken: (accessToken) =>
        set((state) => ({
          accessToken,
          isAuthenticated: Boolean(accessToken && state.user),
        })),
      setUser: (user) =>
        set((state) => ({
          isAuthenticated: Boolean(state.accessToken && user),
          user,
          ...deriveFromUser(user),
        })),
      setOrganizationDetails: (organizationDetails) => set({ organizationDetails }),
    }),
    {
      name: "auth-store",
      storage: {
        getItem: (name) => {
          if (!canUseLocalStorage()) return null;
          try {
            const item = window.localStorage.getItem(name);
            return item ? JSON.parse(item) : null;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          if (!canUseLocalStorage()) return;
          try {
            window.localStorage.setItem(name, JSON.stringify(value));
          } catch {
            // Storage quota exceeded or unavailable
          }
        },
        removeItem: (name) => {
          if (!canUseLocalStorage()) return;
          try {
            window.localStorage.removeItem(name);
          } catch {
            // Storage unavailable
          }
        },
      },
      partialize: (state) => ({
        user: state.user,
        organizationDetails: state.organizationDetails,
      }),
    }
  )
);
