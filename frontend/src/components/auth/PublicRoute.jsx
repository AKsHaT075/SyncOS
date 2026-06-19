"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import RouteLoader from "@/components/auth/RouteLoader";
import { useAuthStore } from "@/store/useAuthStore";

export default function PublicRoute({ children }) {
  const router = useRouter();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return <RouteLoader label="Checking access..." />;
  }

  if (isAuthenticated) {
    return <RouteLoader label="Redirecting..." />;
  }

  return children;
}
