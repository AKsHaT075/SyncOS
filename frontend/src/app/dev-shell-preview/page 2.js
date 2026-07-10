"use client";
import { useEffect } from "react";
import AppShell from "@/components/layout/AppShell";
import { useAuthStore } from "@/store/useAuthStore";

export default function DevShellPreview() {
  useEffect(() => {
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: { id: "1", firstName: "Test", lastName: "User", email: "t@test.com", role: "org-admin", permissions: ["MANAGE_USERS","VIEW_TASK","UPDATE_TEAM","VIEW_MEETING","VIEW_DOCUMENT","MANAGE_ASSETS","VIEW_ANALYTICS","MANAGE_AI"], organization: "org1" },
      role: "org-admin",
      permissions: ["MANAGE_USERS","VIEW_TASK","UPDATE_TEAM","VIEW_MEETING","VIEW_DOCUMENT","MANAGE_ASSETS","VIEW_ANALYTICS","MANAGE_AI"],
      organization: "org1",
      organizationDetails: { id: "org1", name: "PexyArt" },
    });
  }, []);
  return <AppShell><div className="p-6">Preview content</div></AppShell>;
}
