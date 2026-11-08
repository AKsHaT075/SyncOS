"use client";

import Link from "next/link";
import { useState } from "react";
import { KeyRound, Laptop, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PERMISSIONS } from "@/constants/permissions";
import { EmptyState, ErrorState, ListSkeleton, PageHeader, RequirePermission, StatusBadge } from "@/features/assets/components/shared";
import { ReportIssueDialog } from "@/features/assets/components/MaintenanceDialogs";
import { useMyAssets } from "@/features/assets/hooks/assetHooks";
import { expiryLabel, formatDay } from "@/features/assets/utils/format";

function MyAssets() {
  const { data, isLoading, error, refetch } = useMyAssets();
  const [reporting, setReporting] = useState(null);
  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-4 sm:p-6">
      <PageHeader title="My assets" description="Equipment and software licenses assigned to you or your team." />
      {isLoading ? <ListSkeleton rows={3} /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.assets.length === 0 ? (
        <EmptyState icon={Laptop} title="Nothing assigned to you" description="When equipment or a license is assigned to you, it will show up here." />
      ) : (
        <ul className="space-y-3">
          {data.assets.map((asset) => {
            const software = asset.kind === "software";
            const due = asset.assignment.expectedReturnDate;
            const warranty = expiryLabel(asset.warranty.expiryDate);
            return (
              <li key={asset.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{software ? <KeyRound className="size-5" /> : <Laptop className="size-5" />}</span>
                    <div className="min-w-0">
                      <Link href={`/dashboard/assets/${asset.id}`} className="font-medium text-foreground hover:underline">{asset.name}</Link>
                      <p className="text-xs text-muted-foreground">{asset.assetId}{asset.serialNumber ? ` · ${asset.serialNumber}` : ""}{asset.category ? ` · ${asset.category.name}` : ""}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {asset.assignment.viaTeam ? "Shared with your team" : "Assigned to you"} on {formatDay(String(asset.assignment.assignedAt).slice(0, 10))}
                        {due ? ` · return by ${formatDay(due)}` : ""}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={asset.status} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {asset.assignment.overdue ? <span className="rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">Return overdue</span> : null}
                  {asset.assignment.returnRequestedAt ? <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Return requested — please hand it back</span> : null}
                  {!software && warranty ? <span className={`text-xs ${warranty.tone}`}>Warranty: {warranty.text.toLowerCase()}</span> : null}
                  {software && asset.license?.expiryDate ? <span className="text-xs text-muted-foreground">License expires {formatDay(asset.license.expiryDate)}</span> : null}
                  {asset.permissions.canReportIssue && !software ? <Button size="sm" variant="outline" className="ml-auto" onClick={() => setReporting(asset)}><Wrench className="size-4" />Report a problem</Button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ReportIssueDialog open={Boolean(reporting)} onOpenChange={(next) => !next && setReporting(null)} asset={reporting} />
    </div>
  );
}

export default function MyAssetsPage() {
  return <RequirePermission permission={PERMISSIONS.VIEW_OWN_ASSETS}><MyAssets /></RequirePermission>;
}
