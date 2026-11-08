"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, UserMinus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { AssetsSubNav, EmptyState, ErrorState, ListSkeleton, NativeSelect, PageHeader, Pager, Panel, RequirePermission } from "@/features/assets/components/shared";
import { useAssignments, useOffboarding } from "@/features/assets/hooks/assetHooks";
import { conditionLabel } from "@/features/assets/components/shared";
import { formatDateTime, formatDay } from "@/features/assets/utils/format";
import { cn } from "@/lib/utils";

function AssignmentsList() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useAssignments({ page, limit: 20, status: status || undefined });
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <NativeSelect aria-label="Filter by state" className="w-44" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">Active and returned</option><option value="ACTIVE">Active only</option><option value="CLOSED">Returned / ended</option>
        </NativeSelect>
      </div>
      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.assignments.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No assignments" description="Assigned equipment and license seats will be listed here." />
      ) : (
        <>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {data.assignments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/dashboard/assets/${row.asset.id}`} className="font-medium text-foreground hover:underline">{row.asset.name}</Link>
                  <p className="text-xs text-muted-foreground">
                    {row.asset.assetId} · {row.user ? row.user.name : row.team?.name}{row.user?.former ? " (left the organization)" : ""} · since {formatDateTime(row.assignedAt)}
                    {row.expectedReturnDate ? ` · due ${formatDay(row.expectedReturnDate)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {row.overdue ? <span className="font-medium text-destructive">Overdue</span> : null}
                  {row.returnRequestedAt && row.status === "ACTIVE" ? <span className="text-amber-600 dark:text-amber-400">Return requested</span> : null}
                  <span className={cn("rounded-full px-2.5 py-0.5 font-medium", row.status === "ACTIVE" ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : "bg-muted text-muted-foreground")}>
                    {row.status === "ACTIVE" ? "Active" : row.returnedCondition ? `Returned · ${conditionLabel(row.returnedCondition)}` : "Ended"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <Pager pagination={data.pagination} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function Offboarding() {
  const { data, isLoading, error, refetch } = useOffboarding();
  if (isLoading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data.people.length) return <EmptyState icon={UserMinus} title="Nothing to recover" description="No one who has left, been deactivated or blocked is still holding equipment." />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{data.totals.assignments} item{data.totals.assignments === 1 ? "" : "s"} still held by {data.totals.people} former member{data.totals.people === 1 ? "" : "s"}. Open an asset to record its return — the history is kept.</p>
      {data.people.map((entry) => (
        <Panel key={entry.user.id} title={entry.user.name} description={`${entry.user.email} · ${entry.user.status}`}>
          <ul className="divide-y divide-border">
            {entry.assets.map((row) => (
              <li key={row.assignmentId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/dashboard/assets/${row.asset.id}`} className="font-medium text-foreground hover:underline">{row.asset.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{row.asset.assetId}</span></Link>
                <span className="text-xs text-muted-foreground">held since {formatDateTime(row.assignedAt)}{row.asset.location ? ` · ${row.asset.location}` : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

function Page() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Org-wide roles (admins and HR) have reports access; offboarding is also restricted server-side.
  const orgWide = usePermission(PERMISSIONS.VIEW_ASSET_REPORTS);
  const tab = params.get("tab") === "offboarding" && orgWide ? "offboarding" : "assignments";
  const setTab = (value) => router.replace(value === "assignments" ? pathname : `${pathname}?tab=${value}`, { scroll: false });
  return (
    <div className="mx-auto max-w-[1100px] space-y-5 p-4 sm:p-6">
      <PageHeader title="Assignments" description="Who holds what, across the organization." />
      <AssetsSubNav />
      {orgWide ? (
        <div role="tablist" aria-label="Assignments views" className="flex gap-1 rounded-lg bg-muted p-1 text-sm sm:w-fit">
          {[["assignments", "Assignments"], ["offboarding", "Offboarding"]].map(([value, text]) => (
            <button key={value} role="tab" aria-selected={tab === value} type="button" onClick={() => setTab(value)} className={cn("rounded-md px-3 py-1.5 font-medium transition-colors", tab === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>{text}</button>
          ))}
        </div>
      ) : null}
      {tab === "offboarding" ? <Offboarding /> : <AssignmentsList />}
    </div>
  );
}

export default function AssignmentsPage() {
  return (
    <RequirePermission permission={PERMISSIONS.VIEW_ASSETS}>
      <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}><Page /></Suspense>
    </RequirePermission>
  );
}
