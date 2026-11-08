"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Box, CalendarClock, Download, KeyRound, Plus, UserMinus, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import AssetFormDialog from "@/features/assets/components/AssetFormDialog";
import { HorizontalBars, StatusDonut } from "@/features/assets/components/OverviewCharts";
import { AssetsSubNav, EmptyState, ErrorState, PageHeader, Panel, RequirePermission } from "@/features/assets/components/shared";
import { useAssetSummary } from "@/features/assets/hooks/assetHooks";
import { assetService } from "@/features/assets/services/assetService";
import { downloadBlob, formatDay, formatMoney } from "@/features/assets/utils/format";
import { getFriendlyErrorMessage } from "@/lib/error-message";

function Kpi({ label, value, icon: Icon, href, tone }) {
  const body = (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:bg-accent/40">
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
      </div>
      <span className={`flex size-9 items-center justify-center rounded-lg ${tone}`}><Icon className="size-4.5" /></span>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function ListRow({ href, title, meta, badge }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-accent/50">
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        {badge ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{badge}</span> : null}
      </Link>
    </li>
  );
}

function Overview() {
  const { data, isLoading, error, refetch } = useAssetSummary();
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const response = await assetService.exportCsv();
      downloadBlob(response.data, `assets-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (error_) {
      toast.error(getFriendlyErrorMessage(error_));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Assets"
        description="Equipment and software licenses across your organization."
        actions={
          <>
            <Can permission={PERMISSIONS.VIEW_ASSET_REPORTS}>
              <Button variant="outline" onClick={exportCsv} disabled={exporting}><Download className="size-4" />Export CSV</Button>
            </Can>
            <Can permission={PERMISSIONS.CREATE_ASSET}>
              <Button onClick={() => setAdding(true)}><Plus className="size-4" />Add asset</Button>
            </Can>
          </>
        }
      />
      <AssetsSubNav />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Total assets" value={data.totals.total} icon={Box} href="/dashboard/assets/inventory" tone="bg-primary/10 text-primary" />
            <Kpi label="Assigned" value={data.totals.assigned} icon={KeyRound} href="/dashboard/assets/inventory?status=ASSIGNED" tone="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
            <Kpi label="Available" value={data.totals.available} icon={Box} href="/dashboard/assets/inventory?status=AVAILABLE" tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
            <Kpi label="Under maintenance" value={data.totals.underMaintenance} icon={Wrench} href="/dashboard/assets/maintenance" tone="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            <Kpi label="Expired warranties" value={data.totals.expiredWarranties} icon={AlertTriangle} href="/dashboard/assets/inventory?warranty=expired" tone="bg-red-500/10 text-red-600 dark:text-red-400" />
            <Kpi label="Overdue maintenance" value={data.totals.overdueMaintenance} icon={CalendarClock} href="/dashboard/assets/maintenance?view=overdue" tone="bg-red-500/10 text-red-600 dark:text-red-400" />
            <Kpi label="Open repair requests" value={data.totals.openMaintenanceRequests} icon={Wrench} href="/dashboard/assets/maintenance?view=requests" tone="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
            <Kpi label="Held by former members" value={data.totals.heldByFormerMembers} icon={UserMinus} href="/dashboard/assets/assignments?tab=offboarding" tone="bg-orange-500/10 text-orange-600 dark:text-orange-400" />
          </div>

          {data.totals.total === 0 ? (
            <EmptyState icon={Box} title="No assets yet" description="Add your first laptop, monitor or software license to start tracking it." action={<Can permission={PERMISSIONS.CREATE_ASSET}><Button onClick={() => setAdding(true)}><Plus className="size-4" />Add asset</Button></Can>} />
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="By status"><StatusDonut data={data.byStatus} /></Panel>
                <Panel title="By category"><HorizontalBars data={data.byCategory} label="Assets by category" /></Panel>
                <Panel title="By team"><HorizontalBars data={data.byTeam} label="Assets by team" /></Panel>
                <Panel title="Most assets held" description="People currently holding the most equipment">
                  <HorizontalBars data={data.assignmentDistribution.slice().sort((a, b) => b.count - a.count)} label="Assets held per person" />
                </Panel>
              </div>

              {data.purchaseValue ? (
                <Panel title="Purchase value" description="Totals are kept per currency — different currencies are never added together.">
                  {data.purchaseValue.byCurrency.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {data.purchaseValue.byCurrency.map((row) => (
                        <div key={row.currency} className="rounded-lg border border-border p-3">
                          <p className="text-xs text-muted-foreground">{row.currency} · {row.assets} asset{row.assets === 1 ? "" : "s"}</p>
                          <p className="mt-1 text-lg font-semibold text-foreground">{formatMoney(row.total, row.currency)}</p>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No purchase costs recorded yet.</p>}
                </Panel>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-3">
                <Panel title="Warranties expiring soon">
                  {data.expiringWarranties.length ? (
                    <ul>{data.expiringWarranties.map((a) => <ListRow key={a.id} href={`/dashboard/assets/${a.id}`} title={a.name} meta={`${a.assetId} · ${formatDay(a.expiryDate)}`} badge={`${a.daysLeft}d`} />)}</ul>
                  ) : <p className="py-4 text-sm text-muted-foreground">Nothing expiring in the next 30 days.</p>}
                </Panel>
                <Panel title="Licenses expiring soon" description={`${data.licenseSeats.allocated} of ${data.licenseSeats.purchased} seats in use`}>
                  {data.expiringLicenses.length ? (
                    <ul>{data.expiringLicenses.map((a) => <ListRow key={a.id} href={`/dashboard/assets/${a.id}`} title={a.name} meta={`${a.allocatedSeats}/${a.seats} seats · ${formatDay(a.expiryDate || a.renewalDate)}`} />)}</ul>
                  ) : <p className="py-4 text-sm text-muted-foreground">No licenses expiring soon.</p>}
                </Panel>
                <Panel title="Upcoming maintenance">
                  {data.upcomingMaintenance.length ? (
                    <ul>{data.upcomingMaintenance.map((m) => <ListRow key={m.id} href={`/dashboard/assets/${m.asset?.id}`} title={m.asset?.name ?? "Asset"} meta={m.issue} badge={formatDay(m.scheduledDate)} />)}</ul>
                  ) : <p className="py-4 text-sm text-muted-foreground">No maintenance scheduled soon.</p>}
                </Panel>
              </div>

              <Panel title="Recent assignments" action={<Button variant="ghost" size="sm" asChild><Link href="/dashboard/assets/assignments">View all</Link></Button>}>
                {data.recentAssignments.length ? (
                  <ul>{data.recentAssignments.map((row) => <ListRow key={row.id} href={`/dashboard/assets/${row.asset?.id}`} title={row.asset?.name ?? "Asset"} meta={`${row.assignee} · ${row.status === "ACTIVE" ? "assigned" : "returned"}`} badge={formatDay(String(row.assignedAt).slice(0, 10))} />)}</ul>
                ) : <p className="py-4 text-sm text-muted-foreground">No assignments yet.</p>}
              </Panel>
            </>
          )}
        </>
      )}
      <AssetFormDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

export default function AssetsOverviewPage() {
  return <RequirePermission permission={PERMISSIONS.VIEW_ASSETS}><Overview /></RequirePermission>;
}
