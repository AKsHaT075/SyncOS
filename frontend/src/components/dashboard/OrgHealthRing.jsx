"use client";

import { useState } from "react";
import { HeartPulse } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function scoreColor(score) {
  if (score >= 80) return "#10b981";
  if (score >= 60) return "#f59e0b";
  return "#ef4444";
}

function barColor(score) {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-amber-500";
  return "bg-red-500";
}

export default function OrgHealthRing({ overall, breakdown }) {
  const [open, setOpen] = useState(false);
  const color = scoreColor(overall);
  const circumference = 2 * Math.PI * 26;
  const offset = circumference - (overall / 100) * circumference;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="flex w-full items-center gap-3 rounded-xl border border-zinc-200/70 bg-white p-3 text-left transition-shadow hover:shadow-md"
        >
          <span className="relative flex size-16 shrink-0 items-center justify-center">
            <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
              <circle cx="32" cy="32" r="26" fill="none" stroke="#f1f1f4" strokeWidth="6" />
              <circle
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke={color}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
              />
            </svg>
            <span className="absolute text-base font-bold text-zinc-900">{overall}</span>
          </span>
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
              <HeartPulse className="size-3.5 text-emerald-600" />
              Organization health
            </p>
            <p className="text-xs text-zinc-500">Hover or click for the breakdown</p>
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Score breakdown</p>
        <div className="space-y-2.5">
          {breakdown.map((item) => (
            <div key={item.label}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{item.label}</span>
                <span className="font-medium text-zinc-900">{item.score}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className={`h-full rounded-full ${barColor(item.score)}`} style={{ width: `${item.score}%` }} />
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
