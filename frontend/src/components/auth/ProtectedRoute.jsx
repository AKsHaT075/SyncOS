"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import RouteLoader from "@/components/auth/RouteLoader";
import { useAuthStore } from "@/store/useAuthStore";

export default function ProtectedRoute({ children }) {
  const router = useRouter();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return <RouteLoader label="Restoring your session..." />;
  }

  if (!isAuthenticated) {
    return <RouteLoader label="Redirecting to login..." />;
  }

  return children;
}
