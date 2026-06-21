import { create } from "zustand";

const initialState = {
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
  user: null,
  role: null,
  permissions: [],
  organization: null,
};

function deriveFromUser(user) {
  return {
    role: user?.role ?? null,
    permissions: user?.permissions ?? [],
    organization: user?.organization ?? null,
  };
}

export const useAuthStore = create((set) => ({
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
}));
