"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import AppShell from "@/components/layout/AppShell";

export default function DevShellPreview() {
  useEffect(() => {
    useAuthStore.setState({
      accessToken: "fake-token",
      isAuthenticated: true,
      isLoading: false,
      user: { fullName: "Akshat Anand", email: "akshatanand919191@gmail.com", role: "OWNER", permissions: [] },
      role: "OWNER",
      permissions: [],
      organization: "org-1",
      organizationDetails: { id: "org-1", name: "TechNova" },
    });
  }, []);

  return (
    <AppShell>
      <div className="p-6">Preview content</div>
    </AppShell>
  );
}
