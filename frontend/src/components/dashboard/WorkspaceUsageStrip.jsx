"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

const PLAN_STYLES = {
  free: "border-zinc-200 bg-zinc-50 text-zinc-600",
  starter: "border-blue-200 bg-blue-50 text-blue-600",
  pro: "border-violet-200 bg-gradient-to-r from-violet-50 to-indigo-50 text-violet-700",
  enterprise: "border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 text-amber-700",
};

export default function WorkspaceUsageStrip({ plan = "free", seatsUsed, seatsLimit, workspaceAge }) {
  const hasLimit = Number.isFinite(seatsLimit) && seatsLimit > 0;
  const usagePct = hasLimit ? Math.min(100, Math.round((seatsUsed / seatsLimit) * 100)) : 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200/70 bg-white px-4 py-3 sm:flex-row sm:items-center sm:gap-5">
      <span
        className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${PLAN_STYLES[plan] ?? PLAN_STYLES.free}`}
      >
        {plan} plan
      </span>

      <div className="h-4 w-px bg-zinc-200 sm:block hidden" />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-zinc-500">
          Seats {hasLimit ? `${seatsUsed} / ${seatsLimit}` : "—"}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
          <div
            className={`h-full rounded-full ${usagePct >= 90 ? "bg-red-500" : usagePct >= 70 ? "bg-amber-500" : "bg-violet-500"}`}
            style={{ width: `${usagePct}%` }}
          />
        </div>
      </div>

      <div className="h-4 w-px bg-zinc-200 sm:block hidden" />

      <span className="shrink-0 text-xs text-zinc-500">Workspace age · {workspaceAge}</span>

      <Link
        href="/dashboard/settings"
        className="flex shrink-0 items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-700"
      >
        Manage plan
        <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}
