"use client";

import Link from "next/link";
import { ShieldCheck, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AuthPageShell({ children, description, footer, title }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.25),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(15,118,110,0.18),_transparent_28%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="order-2 lg:order-1">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-4 py-2 text-sm text-slate-200 backdrop-blur">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            SynapseOS secure access
          </div>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            AI-native workspace authentication built for production.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
            {description || "Access your workspace, restore sessions seamlessly, and keep every device under control."}
          </p>
          <div className="mt-8 grid max-w-2xl gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur">
              <Sparkles className="h-5 w-5 text-cyan-300" />
              <p className="mt-3 text-sm font-medium text-white">Session restore</p>
              <p className="mt-1 text-sm text-slate-300">Users stay signed in across reloads with secure refresh rotation.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur">
              <ShieldCheck className="h-5 w-5 text-emerald-300" />
              <p className="mt-3 text-sm font-medium text-white">Device-aware security</p>
              <p className="mt-1 text-sm text-slate-300">Track sessions, revoke devices, and keep access auditable.</p>
            </div>
          </div>
          <p className="mt-6 text-sm text-slate-400">
            Need the app shell? Visit <Link className="text-cyan-300 underline-offset-4 hover:underline" href="/dashboard">dashboard</Link> after sign in.
          </p>
        </section>

        <section className="order-1 lg:order-2"> 
          <Card className="border-white/10 bg-slate-950/75 text-slate-100 shadow-2xl shadow-slate-950/40 backdrop-blur-xl">
            <CardHeader className="space-y-2 border-b border-white/10">
              <CardTitle className="text-2xl text-white">{title}</CardTitle>
              <CardDescription className="text-slate-300">{description}</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">{children}</CardContent>
          </Card>
          {footer ? <div className="mt-4 text-center text-sm text-slate-300">{footer}</div> : null}
        </section>
      </div>
    </div>
  );
}
