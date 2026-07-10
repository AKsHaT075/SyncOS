"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import RouteLoader from "@/components/auth/RouteLoader";
import { useAuthStore } from "@/store/useAuthStore";

function RedirectIfOnboarded({ children }) {
  const router = useRouter();
  const organization = useAuthStore((state) => state.organization);

  useEffect(() => {
    if (organization) {
      router.replace("/dashboard");
    }
  }, [organization, router]);

  if (organization) {
    return <RouteLoader label="Taking you to your dashboard..." />;
  }

  return children;
}

export default function OnboardingLayout({ children }) {
  return (
    <ProtectedRoute>
      <RedirectIfOnboarded>
        <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
          {children}
        </div>
      </RedirectIfOnboarded>
    </ProtectedRoute>
  );
}
