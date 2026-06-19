"use client";

import Link from "next/link";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authService } from "@/features/auth/services/authService";
import { useAuthStore } from "@/store/useAuthStore";
import { toast } from "sonner";

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const handleLogout = async () => {
    try {
      await authService.logout();
    } finally {
      logout();
      toast.success("Signed out successfully");
    }
  };

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.2),_transparent_30%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl space-y-6">
          <div className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-cyan-300">SynapseOS</p>
              <h1 className="mt-2 text-3xl font-semibold">Welcome back{user?.fullName ? `, ${user.fullName}` : ""}.</h1>
              <p className="mt-2 text-slate-300">Your session is restored and your access token is ready for secure API calls.</p>
            </div>
            <div className="flex gap-3">
              <Button asChild variant="outline">
                <Link href="/login">Auth screens</Link>
              </Button>
              <Button onClick={handleLogout}>Sign out</Button>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Card className="border-white/10 bg-slate-950/60 text-slate-100">
              <CardHeader>
                <CardTitle>Current user</CardTitle>
                <CardDescription className="text-slate-400">Data comes from Zustand after session restore.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-slate-300">
                <p><span className="text-slate-400">Email:</span> {user?.email || "Unknown"}</p>
                <p><span className="text-slate-400">Role:</span> {user?.role || "employee"}</p>
                <p><span className="text-slate-400">Verified:</span> {user?.emailVerified ? "Yes" : "No"}</p>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-slate-950/60 text-slate-100">
              <CardHeader>
                <CardTitle>Security model</CardTitle>
                <CardDescription className="text-slate-400">Backend refresh rotation, Redis sessions, and CSRF protection are active.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-slate-300">
                <p>• 15 minute access tokens</p>
                <p>• 7 day refresh rotation</p>
                <p>• Device-aware sessions</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
