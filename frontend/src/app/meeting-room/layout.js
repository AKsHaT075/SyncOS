"use client";

import ProtectedRoute from "@/components/auth/ProtectedRoute";
import OrganizationGate from "@/components/auth/OrganizationGate";

// Deliberately outside /dashboard's layout — no Sidebar/Topbar/AppShell.
// The call now always opens in its own tab (see the Join button and instant
// meeting handler), so it should be genuinely full-screen, like Google
// Meet's own tab, not squeezed inside the app's normal chrome. Still
// wrapped in the same auth/org gates as everywhere else — just without the
// nav shell around it.
export default function MeetingRoomLayout({ children }) {
  return (
    <ProtectedRoute>
      <OrganizationGate>
        <div className="h-screen w-screen overflow-hidden bg-zinc-950">{children}</div>
      </OrganizationGate>
    </ProtectedRoute>
  );
}
