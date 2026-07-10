"use client";

import { ShieldCheck, ShieldAlert, KeyRound, Laptop } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";

// No security-metrics endpoint yet — preview values, wired up once the
// security/audit module exposes aggregates.
const SECURITY_STATS = [
  { label: "2FA adoption", value: "70%", icon: ShieldCheck, accent: "text-emerald-600 bg-emerald-50" },
  { label: "Failed logins (7d)", value: "3", icon: ShieldAlert, accent: "text-amber-600 bg-amber-50" },
  { label: "Active sessions", value: "12", icon: Laptop, accent: "text-sky-600 bg-sky-50" },
  { label: "Stale invites (30d)", value: "0", icon: KeyRound, accent: "text-violet-600 bg-violet-50" },
];

export default function SecuritySnapshotCard() {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={ShieldCheck} iconClassName="bg-emerald-50 text-emerald-600" title="Security snapshot" preview />

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {SECURITY_STATS.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-zinc-100 p-2.5">
            <span className={`flex size-6 items-center justify-center rounded-lg ${stat.accent}`}>
              <stat.icon className="size-3" />
            </span>
            <p className="mt-1.5 text-base font-bold text-zinc-900">{stat.value}</p>
            <p className="text-[0.65rem] text-zinc-500">{stat.label}</p>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
