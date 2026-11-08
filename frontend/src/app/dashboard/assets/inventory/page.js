"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Download, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import AssetFormDialog from "@/features/assets/components/AssetFormDialog";
import AssetTable from "@/features/assets/components/AssetTable";
import { AssetsSubNav, EmptyState, ErrorState, ListSkeleton, NativeSelect, PageHeader, Pager, RequirePermission } from "@/features/assets/components/shared";
import { KINDS, SORTS, STATUSES, WARRANTY_FILTERS } from "@/features/assets/constants/assetOptions";
import { useAssetOptions, useAssets, useCategories } from "@/features/assets/hooks/assetHooks";
import { assetService } from "@/features/assets/services/assetService";
import { downloadBlob } from "@/features/assets/utils/format";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const LIMIT = 20;
const FILTER_KEYS = ["status", "categoryId", "kind", "warranty", "location", "holder"];

function Inventory() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);

  // All filter state lives in the URL, so views can be shared and the back button works.
  const get = (key, fallback = "") => params.get(key) ?? fallback;
  const [searchText, setSearchText] = useState(get("search"));
  const debouncedSearch = useDebouncedValue(searchText, 300);
  const setParams = (changes) => {
    const next = new URLSearchParams(params.toString());
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    if (!("page" in changes)) next.delete("page");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };
  useEffect(() => {
    if (debouncedSearch !== get("search")) setParams({ search: debouncedSearch.trim() });
  }, [debouncedSearch]);

  const page = Number(get("page", "1")) || 1;
  const query = {
    page, limit: LIMIT, sortBy: get("sortBy", "createdAt"), sortOrder: get("sortOrder", "desc"),
    ...Object.fromEntries(["search", ...FILTER_KEYS, "includeArchived"].map((key) => [key, get(key) || undefined]).filter(([, value]) => value)),
  };
  const { data, isLoading, error, refetch, isFetching } = useAssets(query);
  const { data: categories } = useCategories();
  const { data: options } = useAssetOptions();
  const filtersActive = Boolean(get("search")) || FILTER_KEYS.some((key) => get(key)) || get("includeArchived");

  const exportCsv = async () => {
    setExporting(true);
    try {
      const response = await assetService.exportCsv(Object.fromEntries(Object.entries(query).filter(([key]) => !["page", "limit", "sortBy", "sortOrder"].includes(key))));
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
        title="Inventory"
        description="Search, filter and manage every asset."
        actions={
          <>
            <Can permission={PERMISSIONS.VIEW_ASSET_REPORTS}><Button variant="outline" onClick={exportCsv} disabled={exporting}><Download className="size-4" />Export</Button></Can>
            <Can permission={PERMISSIONS.CREATE_ASSET}><Button onClick={() => setAdding(true)}><Plus className="size-4" />Add asset</Button></Can>
          </>
        }
      />
      <AssetsSubNav />

      <div className="space-y-3 rounded-xl border border-border bg-card p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search assets" className="pl-9" placeholder="Search by name, asset ID, tag or serial number" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <NativeSelect aria-label="Status" value={get("status")} onChange={(event) => setParams({ status: event.target.value })}>
            <option value="">All statuses</option>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Category" value={get("categoryId")} onChange={(event) => setParams({ categoryId: event.target.value })}>
            <option value="">All categories</option>{(categories?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Type" value={get("kind")} onChange={(event) => setParams({ kind: event.target.value })}>
            <option value="">Hardware & software</option>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Warranty" value={get("warranty")} onChange={(event) => setParams({ warranty: event.target.value })}>
            <option value="">Any warranty</option>{WARRANTY_FILTERS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Location" value={get("location")} onChange={(event) => setParams({ location: event.target.value })}>
            <option value="">Any location</option>{(options?.locations ?? []).map((l) => <option key={l} value={l}>{l}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Holder" value={get("holder")} onChange={(event) => setParams({ holder: event.target.value })}>
            <option value="">Any holder</option><option value="unassigned">Unassigned</option><option value="former">Held by former members</option>
          </NativeSelect>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <NativeSelect aria-label="Sort by" className="w-44" value={get("sortBy", "createdAt")} onChange={(event) => setParams({ sortBy: event.target.value })}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </NativeSelect>
            <NativeSelect aria-label="Order" className="w-32" value={get("sortOrder", "desc")} onChange={(event) => setParams({ sortOrder: event.target.value })}>
              <option value="asc">Ascending</option><option value="desc">Descending</option>
            </NativeSelect>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={get("includeArchived") === "true"} onChange={(event) => setParams({ includeArchived: event.target.checked ? "true" : "" })} />
              Show archived
            </label>
            {filtersActive ? <Button variant="ghost" size="sm" onClick={() => { setSearchText(""); router.replace(pathname, { scroll: false }); }}><X className="size-4" />Clear</Button> : null}
          </div>
        </div>
      </div>

      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.assets.length === 0 ? (
        filtersActive ? (
          <EmptyState icon={Search} title="No assets match these filters" description="Try a different search or clear the filters." />
        ) : (
          <EmptyState icon={Box} title="No assets yet" description="Add equipment or a software license to start tracking it." action={<Can permission={PERMISSIONS.CREATE_ASSET}><Button onClick={() => setAdding(true)}><Plus className="size-4" />Add asset</Button></Can>} />
        )
      ) : (
        <div className={isFetching ? "opacity-70 transition-opacity" : "transition-opacity"}>
          <AssetTable assets={data.assets} />
          <Pager pagination={data.pagination} onPage={(next) => setParams({ page: String(next) })} />
        </div>
      )}
      <AssetFormDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

export default function InventoryPage() {
  return (
    <RequirePermission permission={PERMISSIONS.VIEW_ASSETS}>
      <Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full rounded-xl" /></div>}><Inventory /></Suspense>
    </RequirePermission>
  );
}
