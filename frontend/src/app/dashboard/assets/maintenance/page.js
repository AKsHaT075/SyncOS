"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { AssetsSubNav, EmptyState, ErrorState, ListSkeleton, MaintenanceBadge, PageHeader, Pager, RequirePermission } from "@/features/assets/components/shared";
import { ApproveRequestDialog, CompleteMaintenanceDialog, ReasonDialog } from "@/features/assets/components/MaintenanceDialogs";
import { MAINTENANCE_TYPES } from "@/features/assets/constants/assetOptions";
import { useMaintenanceAction, useMaintenanceList } from "@/features/assets/hooks/assetHooks";
import { formatDay, formatMoney } from "@/features/assets/utils/format";
import { cn } from "@/lib/utils";

const VIEWS = [
  { value: "", label: "All" },
  { value: "requests", label: "Requests" },
  { value: "upcoming", label: "Upcoming" },
  { value: "overdue", label: "Overdue" },
];

function Page() {
  const initial = useSearchParams().get("view") ?? "";
  const [view, setView] = useState(VIEWS.some((v) => v.value === initial) ? initial : "");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState({ type: null, record: null });
  const manage = usePermission(PERMISSIONS.MANAGE_ASSET_MAINTENANCE);
  const { data, isLoading, error, refetch } = useMaintenanceList({ page, limit: 20, view: view || undefined });
  const action = useMaintenanceAction();
  const close = () => setDialog({ type: null, record: null });
  const assetOf = (record) => ({ id: record.asset.id, name: record.asset.name, assetId: record.asset.assetId, purchase: { currency: "INR" } });

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 p-4 sm:p-6">
      <PageHeader title="Maintenance" description="Repair requests, scheduled work and service history." />
      <AssetsSubNav />
      <div role="tablist" aria-label="Maintenance views" className="flex w-fit gap-1 rounded-lg bg-muted p-1 text-sm">
        {VIEWS.map((v) => (
          <button key={v.value} role="tab" aria-selected={view === v.value} type="button" onClick={() => { setView(v.value); setPage(1); }} className={cn("rounded-md px-3 py-1.5 font-medium transition-colors", view === v.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>{v.label}</button>
        ))}
      </div>

      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.maintenance.length === 0 ? (
        <EmptyState icon={Wrench} title="No maintenance records" description="Requests from employees and scheduled work will appear here." />
      ) : (
        <>
          <ul className="space-y-3">
            {data.maintenance.map((record) => (
              <li key={record.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/dashboard/assets/${record.asset.id}`} className="text-sm font-medium text-foreground hover:underline">{record.asset.name} <span className="font-normal text-muted-foreground">{record.asset.assetId}</span></Link>
                    <p className="mt-0.5 text-sm text-foreground">{record.issue}</p>
                    <p className="text-xs text-muted-foreground">
                      {MAINTENANCE_TYPES.find((t) => t.value === record.type)?.label ?? record.type}
                      {record.reportedBy ? ` · reported by ${record.reportedBy.name}` : ""}
                      {record.scheduledDate ? ` · ${formatDay(record.scheduledDate)}` : ""}
                      {record.cost !== undefined && record.cost !== null ? ` · ${formatMoney(record.cost, record.currency)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {record.overdue ? <span className="text-xs font-medium text-destructive">Overdue</span> : null}
                    <MaintenanceBadge status={record.status} />
                  </div>
                </div>
                {manage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {record.status === "REQUESTED" ? (<><Button size="sm" onClick={() => setDialog({ type: "approve", record })}>Approve</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "decline", record })}>Decline</Button></>) : null}
                    {record.status === "SCHEDULED" ? (<><Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: record.asset.id, maintenanceId: record.id, action: "start" })}>Start</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "cancel", record })}>Cancel</Button></>) : null}
                    {record.status === "IN_PROGRESS" ? (<><Button size="sm" onClick={() => setDialog({ type: "complete", record })}>Complete</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "cancel", record })}>Cancel</Button></>) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <Pager pagination={data.pagination} onPage={setPage} />
        </>
      )}

      {dialog.record ? (
        <>
          <ApproveRequestDialog open={dialog.type === "approve"} onOpenChange={(next) => !next && close()} asset={assetOf(dialog.record)} maintenance={dialog.record} />
          <CompleteMaintenanceDialog open={dialog.type === "complete"} onOpenChange={(next) => !next && close()} asset={assetOf(dialog.record)} maintenance={dialog.record} />
          <ReasonDialog open={dialog.type === "decline" || dialog.type === "cancel"} onOpenChange={(next) => !next && close()} asset={assetOf(dialog.record)} maintenance={dialog.record} action={dialog.type === "decline" ? "decline" : "cancel"} />
        </>
      ) : null}
    </div>
  );
}

export default function MaintenancePage() {
  return (
    <RequirePermission permission={PERMISSIONS.VIEW_ASSETS}>
      <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}><Page /></Suspense>
    </RequirePermission>
  );
}
