"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PERMISSIONS } from "@/constants/permissions";
import { ROLES } from "@/constants/roles";
import { useAuthStore } from "@/store/useAuthStore";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { FilterBar, Notes, QueryBoundary, RestrictedState } from "@/features/analytics/components/ui";
import { useReport } from "@/features/analytics/hooks/analyticsHooks";
import { analyticsService } from "@/features/analytics/services/analyticsService";
import { apiParams, filtersFromParams } from "@/features/analytics/utils/filters";
import { downloadBlob } from "@/features/analytics/utils/format";
import { EmptyState, Field, NativeSelect, PageHeader, Pager } from "@/features/assets/components/shared";
import { formatDay } from "@/features/assets/utils/format";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const REPORTS = [
  { value: "tasks", label: "Tasks" }, { value: "projects", label: "Projects", hidden: [ROLES.HR] }, { value: "people", label: "People workload" },
  { value: "teams", label: "Teams" }, { value: "meetings", label: "Meetings", hidden: [ROLES.HR] }, { value: "assets", label: "Assets", needs: PERMISSIONS.VIEW_ASSETS },
];

function Cell({ column, value }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (column.type === "number") return Number(value).toLocaleString();
  if (column.type === "percent") return `${value}%`;
  if (column.type === "date") return formatDay(value);
  if (column.type === "datetime") return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return String(value);
}

function Reports() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const role = useAuthStore((state) => state.user?.role);
  const canOrg = usePermission(PERMISSIONS.VIEW_ANALYTICS);
  const canAssets = usePermission(PERMISSIONS.VIEW_ASSETS);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const available = REPORTS.filter((report) => !report.hidden?.includes(role) && (!report.needs || canAssets));
  const type = available.some((report) => report.value === params.get("type")) ? params.get("type") : available[0]?.value;
  const filters = filtersFromParams(params);
  const request = apiParams(filters);
  const query = useReport(type, { ...request, page, limit: 25 }, { enabled: canOrg && Boolean(type) });
  const setParams = (changes) => {
    const next = new URLSearchParams(params.toString());
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    setPage(1);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  if (!canOrg) return <div className="p-6"><RestrictedState title="Reports aren't available for your role" /></div>;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const response = await analyticsService.exportCsv(type, request);
      downloadBlob(response.data, `${type}-report-${request.from}_to_${request.to}.csv`);
    } catch (error) {
      toast.error(getFriendlyErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Reports"
        description={role === ROLES.HR ? "Counts and workload only. Task and project details are not included." : "Detailed tables with the same numbers as the analytics views."}
        actions={<><Button variant="outline" className="print:hidden" onClick={() => window.print()}><Printer className="size-4" />Print</Button><Button variant="outline" className="print:hidden" onClick={exportCsv} disabled={exporting}><Download className="size-4" />Export CSV</Button></>}
      />
      <div className="max-w-xs print:hidden">
        <Field label="Report" htmlFor="rp-type">
          <NativeSelect id="rp-type" value={type} onChange={(event) => setParams({ type: event.target.value })}>
            {available.map((report) => <option key={report.value} value={report.value}>{report.label}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <div className="print:hidden"><FilterBar value={filters} onChange={setParams} projects={role !== ROLES.HR} /></div>

      <QueryBoundary query={query}>
        {(data) => (data.rows.length === 0 ? <EmptyState title="No rows for these filters" description="Try a wider date range or fewer filters." /> : (
          <>
            <p className="text-xs text-muted-foreground">{data.range.from} → {data.range.to} · {data.range.timeZone} · {data.pagination.total} row{data.pagination.total === 1 ? "" : "s"}{data.truncated ? " (list capped; narrow the filters)" : ""}</p>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>{data.columns.map((column) => <th key={column.key} scope="col" className={`px-4 py-2.5 font-medium ${["number", "percent"].includes(column.type) ? "text-right" : ""}`}>{column.label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.rows.map((row, index) => (
                    <tr key={row.id || `${index}-${row[data.columns[0].key]}`} className="hover:bg-accent/40">
                      {data.columns.map((column) => <td key={column.key} className={`px-4 py-2.5 text-foreground ${["number", "percent"].includes(column.type) ? "text-right tabular-nums" : ""}`}><Cell column={column} value={row[column.key]} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="print:hidden"><Pager pagination={data.pagination} onPage={setPage} /></div>
            <Notes notes={data.notes} />
          </>
        ))}
      </QueryBoundary>
    </div>
  );
}

export default function ReportsPage() {
  return <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}><Reports /></Suspense>;
}
