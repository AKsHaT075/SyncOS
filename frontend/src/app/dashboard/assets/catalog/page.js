"use client";

import { useState } from "react";
import { Building2, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Can from "@/components/auth/Can";
import { PERMISSIONS } from "@/constants/permissions";
import { ArchiveCategoryDialog, CategoryDialog, VendorDialog } from "@/features/assets/components/CatalogDialogs";
import { AssetsSubNav, EmptyState, ErrorState, ListSkeleton, PageHeader, Panel, RequirePermission } from "@/features/assets/components/shared";
import { useCategories, useRemoveVendor, useVendors } from "@/features/assets/hooks/assetHooks";

function Categories() {
  const { data, isLoading, error, refetch } = useCategories();
  const [dialog, setDialog] = useState({ type: null, item: null });
  const close = () => setDialog({ type: null, item: null });
  return (
    <Panel
      title="Categories"
      description="Group assets so they're easy to find and report on."
      action={<Can permission={PERMISSIONS.MANAGE_ASSET_CATEGORIES}><Button size="sm" onClick={() => setDialog({ type: "category", item: null })}><Plus className="size-4" />New</Button></Can>}
    >
      {isLoading ? <ListSkeleton rows={4} /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.categories.length === 0 ? <EmptyState icon={Tags} title="No categories" /> : (
        <ul className="divide-y divide-border">
          {data.categories.map((category) => (
            <li key={category.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0"><p className="truncate font-medium text-foreground">{category.name}</p><p className="text-xs text-muted-foreground">{category.assetCount} asset{category.assetCount === 1 ? "" : "s"}</p></div>
              <Can permission={PERMISSIONS.MANAGE_ASSET_CATEGORIES}>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label={`Rename ${category.name}`} onClick={() => setDialog({ type: "category", item: category })}><Pencil className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Archive ${category.name}`} onClick={() => setDialog({ type: "archive", item: category })}><Trash2 className="size-4" /></Button>
                </div>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <CategoryDialog open={dialog.type === "category"} onOpenChange={(next) => !next && close()} category={dialog.item} />
      <ArchiveCategoryDialog open={dialog.type === "archive"} onOpenChange={(next) => !next && close()} category={dialog.item} />
    </Panel>
  );
}

function Vendors() {
  const { data, isLoading, error, refetch } = useVendors();
  const remove = useRemoveVendor();
  const [dialog, setDialog] = useState({ open: false, vendor: null });
  return (
    <Panel
      title="Vendors"
      description="Suppliers and service providers you buy from or hire for repairs."
      action={<Can permission={PERMISSIONS.MANAGE_ASSET_VENDORS}><Button size="sm" onClick={() => setDialog({ open: true, vendor: null })}><Plus className="size-4" />Add</Button></Can>}
    >
      {isLoading ? <ListSkeleton rows={4} /> : error ? <ErrorState error={error} onRetry={refetch} /> : data.vendors.length === 0 ? <EmptyState icon={Building2} title="No vendors yet" description="Add the suppliers you buy equipment from." /> : (
        <ul className="divide-y divide-border">
          {data.vendors.map((vendor) => (
            <li key={vendor.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{vendor.name}</p>
                <p className="truncate text-xs text-muted-foreground">{[vendor.contactPerson, vendor.email, vendor.phone].filter(Boolean).join(" · ") || "No contact details"} · {vendor.assetCount} asset{vendor.assetCount === 1 ? "" : "s"}</p>
              </div>
              <Can permission={PERMISSIONS.MANAGE_ASSET_VENDORS}>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label={`Edit ${vendor.name}`} onClick={() => setDialog({ open: true, vendor })}><Pencil className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${vendor.name}`} disabled={remove.isPending} onClick={() => remove.mutate(vendor.id)}><Trash2 className="size-4" /></Button>
                </div>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <VendorDialog open={dialog.open} onOpenChange={(next) => !next && setDialog({ open: false, vendor: null })} vendor={dialog.vendor} />
    </Panel>
  );
}

export default function CatalogPage() {
  return (
    <RequirePermission permission={PERMISSIONS.VIEW_ASSETS}>
      <div className="mx-auto max-w-[1100px] space-y-5 p-4 sm:p-6">
        <PageHeader title="Catalog" description="Categories and vendors used across the inventory." />
        <AssetsSubNav />
        <div className="grid gap-4 lg:grid-cols-2"><Categories /><Vendors /></div>
      </div>
    </RequirePermission>
  );
}
