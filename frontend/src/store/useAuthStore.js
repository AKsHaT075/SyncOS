import { create } from "zustand";

const initialState = {
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
  user: null,
};

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
    })),
}));
