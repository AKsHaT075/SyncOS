import Link from "next/link";
import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.25),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(16,185,129,0.18),_transparent_28%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-4 py-2 text-sm text-slate-200 backdrop-blur">
            <Sparkles className="h-4 w-4 text-cyan-300" />
            SynapseOS platform access
          </div>
          <h1 className="mt-6 max-w-3xl text-5xl font-semibold tracking-tight text-white sm:text-6xl">
            AI-native company software with secure authentication built in.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
            Sign in, verify your account, restore sessions automatically, and manage devices with refresh rotation, CSRF protection, and audit logs.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/login">
                Sign in
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/register">Create account</Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-4">
          <Card className="border-white/10 bg-white/6 text-slate-100 backdrop-blur">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white"><ShieldCheck className="h-5 w-5 text-cyan-300" /> Security first</CardTitle>
              <CardDescription className="text-slate-300">Production-ready auth patterns for a modern SaaS workspace.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-slate-300">
              HTTP-only cookies, device sessions, lockouts, OTP verification, and role-based access control.
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-slate-950/60 text-slate-100 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-white">Start fast</CardTitle>
              <CardDescription className="text-slate-300">Use the auth flow to restore your session or onboard a new user.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-slate-300">
              The frontend is wired to refresh the session on load and redirect authenticated users to the dashboard.
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
