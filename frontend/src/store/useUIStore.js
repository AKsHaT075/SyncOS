import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useUIStore = create(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      commandPaletteOpen: false,
      aiPanelOpen: false,
      activeOrganization: null,
      notifications: [],

      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),

      openMobileSidebar: () => set({ mobileSidebarOpen: true }),
      closeMobileSidebar: () => set({ mobileSidebarOpen: false }),

      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      setAIPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      toggleAIPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),

      setActiveOrganization: (activeOrganization) => set({ activeOrganization }),

      setNotifications: (notifications) => set({ notifications }),
    }),
    {
      name: "syncos-ui",
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        activeOrganization: state.activeOrganization,
      }),
    }
  )
);
