"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import RouteLoader from "@/components/auth/RouteLoader";
import { useAuthStore } from "@/store/useAuthStore";

export default function OrganizationGate({ children }) {
  const router = useRouter();
  const organization = useAuthStore((state) => state.organization);

  useEffect(() => {
    if (!organization) {
      router.replace("/onboarding");
    }
  }, [organization, router]);

  if (!organization) {
    return <RouteLoader label="Setting up your workspace..." />;
  }

  return children;
}
