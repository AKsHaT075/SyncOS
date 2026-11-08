"use client";

import ProtectedRoute from "@/components/auth/ProtectedRoute";
import OrganizationGate from "@/components/auth/OrganizationGate";
import AppShell from "@/components/layout/AppShell";
import SectionBadgeSync from "@/features/notifications/components/SectionBadgeSync";

export default function DashboardLayout({ children }) {
  return (
    <ProtectedRoute>
      <OrganizationGate>
        <AppShell>{children}</AppShell>
        <SectionBadgeSync />
      </OrganizationGate>
    </ProtectedRoute>
  );
}
