"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/layout/Sidebar";
import MobileSidebar from "@/components/layout/MobileSidebar";
import Topbar from "@/components/layout/Topbar";
import CommandPalette from "@/components/layout/CommandPalette";
import AIAssistantPanel from "@/components/layout/AIAssistantPanel";
import NotificationRealtime from "@/features/notifications/realtime/NotificationRealtime";

export default function AppShell({ children }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <MobileSidebar />

        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />
          <main className="flex-1 overflow-y-auto bg-white">{children}</main>
        </div>

        <AIAssistantPanel />
      </div>

      <CommandPalette />
      <NotificationRealtime />
    </TooltipProvider>
  );
}
