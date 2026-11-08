"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import RouteLoader from "@/components/auth/RouteLoader";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/useAuthStore";
import { authService } from "@/features/auth/services/authService";

export default function OrganizationGate({ children }) {
  const router = useRouter();
  const organization = useAuthStore((state) => state.organization);
  const orgBlocked = useAuthStore((state) => state.user?.orgBlocked);
  const organizationDetails = useAuthStore((state) => state.organizationDetails);
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    if (!organization) {
      router.replace("/onboarding");
    }
  }, [organization, router]);

  if (!organization) {
    return <RouteLoader label="Setting up your workspace..." />;
  }

  if (orgBlocked) {
    const handleSignOut = async () => {
      try {
        await authService.logout();
      } finally {
        logout();
        toast.success("Signed out successfully");
        router.replace("/login");
      }
    };

    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-background/95 px-4">
        <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
            <Ban className="size-7 text-destructive" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold text-foreground">
              You&apos;ve been blocked from {organizationDetails?.name || "this organization"}
            </h1>
            <p className="text-sm text-muted-foreground">
              An admin has permanently revoked your access to this organization. Your account
              itself is unaffected — you can sign in elsewhere or contact an admin here to be
              reinstated.
            </p>
          </div>
          <Button variant="outline" onClick={handleSignOut} className="mt-2">
            Sign Out
          </Button>
        </div>
      </div>
    );
  }

  return children;
}
