"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { FileBarChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PERMISSIONS } from "@/constants/permissions";
import { ROLES } from "@/constants/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { FilterBar, RestrictedState } from "@/features/analytics/components/ui";
import { AnalyticsView, PlatformSection } from "@/features/analytics/components/views";
import { apiParams, filtersFromParams } from "@/features/analytics/utils/filters";
import { PageHeader } from "@/features/assets/components/shared";
import { cn } from "@/lib/utils";

function Analytics() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const role = useAuthStore((state) => state.user?.role);
  const canOrg = usePermission(PERMISSIONS.VIEW_ANALYTICS);
  const canOwn = usePermission(PERMISSIONS.VIEW_OWN_ANALYTICS);
  const canAssets = usePermission(PERMISSIONS.VIEW_ASSETS);

  // Which tabs exist depends on the role. The server enforces the same limits on every request.
  const tabs = [];
  if (role === ROLES.SUPER_ADMIN) tabs.push({ value: "platform", label: "Platform" });
  if (canOrg) {
    tabs.push({ value: "overview", label: role === ROLES.MANAGER ? "My team" : "Overview" }, { value: "tasks", label: "Tasks" }, { value: "projects", label: "Projects" },
      { value: "people", label: "People" }, { value: "teams", label: "Teams" }, { value: "meetings", label: "Meetings" });
    if (canAssets) tabs.push({ value: "assets", label: "Assets" });
  }
  if (canOwn) tabs.push({ value: "me", label: canOrg ? "My analytics" : "Overview" });

  const view = tabs.some((tab) => tab.value === params.get("view")) ? params.get("view") : tabs[0]?.value;
  const filters = filtersFromParams(params);
  const setParams = (changes) => {
    const next = new URLSearchParams(params.toString());
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  if (!tabs.length) return <div className="p-6"><RestrictedState /></div>;

  const platform = view === "platform";
  const personal = view === "me" || (!canOrg && view === "overview");
  const showFilters = canOrg && !personal && !platform;
  const request = apiParams(filters);
  const isHr = role === ROLES.HR;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Analytics"
        description={platform ? "Platform-wide counts. No organization content is shown here." : personal ? "Your own work, deadlines, meetings and assets." : isHr ? "Organization-wide counts and workload. Task and project details are not shown." : "Real numbers from your workspace."}
        actions={canOrg ? <Button variant="outline" asChild><Link href="/dashboard/reports"><FileBarChart className="size-4" />Reports</Link></Button> : null}
      />

      <nav aria-label="Analytics views" className="-mx-1 overflow-x-auto border-b border-border print:hidden">
        <div className="flex min-w-max px-1">
          {tabs.map((tab) => (
            <button key={tab.value} type="button" aria-current={tab.value === view ? "page" : undefined} onClick={() => setParams({ view: tab.value })}
              className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab.value === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="print:hidden">
        <FilterBar value={filters} onChange={setParams} teams={showFilters} people={showFilters} projects={showFilters && !isHr} />
      </div>

      {platform ? <PlatformSection params={{ from: request.from, to: request.to }} /> : <AnalyticsView key={view} type={view} params={personal ? { from: request.from, to: request.to } : request} />}
    </div>
  );
}

export default function AnalyticsPage() {
  return <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}><Analytics /></Suspense>;
}
