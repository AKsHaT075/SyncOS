"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// These map 1:1 to the Project Detail tabs in the spec. Overview, Members,
// and Resources have real content — the rest render a shared ComingSoon
// placeholder for now.
const TABS = [
  { label: "Overview", segment: "" },
  { label: "Tasks", segment: "tasks" },
  { label: "Members", segment: "members" },
  { label: "Meetings", segment: "meetings" },
  { label: "Resources", segment: "resources" },
  { label: "Goals", segment: "goals" },
  { label: "Activity", segment: "activity" },
  { label: "Analytics", segment: "analytics" },
  { label: "Settings", segment: "settings" },
];

export default function ProjectDetailLayout({ children }) {
  const { projectId } = useParams();
  const pathname = usePathname();
  const basePath = `/dashboard/projects/${projectId}`;

  return (
    <div className="space-y-4 p-6">
      {/*
          Each tab is a real route (Overview/Tasks/.../Settings each have their
          own page.js), so this is a plain nav styled like tabs rather than a
          Radix Tabs (which controls same-page panels, not routing).
        */}
        <nav className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200">
          {TABS.map((tab) => {
            const href = tab.segment ? `${basePath}/${tab.segment}` : basePath;
            const isActive = pathname === href;
            return (
              <Link
                key={tab.label}
                href={href}
                className={cn(
                  "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-zinc-900 text-zinc-900 font-semibold"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

      <div>{children}</div>
    </div>
  );
}
