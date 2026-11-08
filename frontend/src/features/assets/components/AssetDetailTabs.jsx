"use client";

import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Link2, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { ACTIVITY_LABELS, DOCUMENT_KINDS, LICENSE_TYPES, MAINTENANCE_TYPES } from "@/features/assets/constants/assetOptions";
import {
  useAssetActivity, useAssetDocuments, useAssetHistory, useAssetMaintenance, useLinkDocument, useMaintenanceAction, useUnlinkDocument,
} from "@/features/assets/hooks/assetHooks";
import { linkDocumentSchema } from "@/features/assets/schemas/assetSchemas";
import { documentService } from "@/features/documents/services/documentService";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { conditionLabel, EmptyState, ErrorState, Field, ListSkeleton, MaintenanceBadge, NativeSelect, Pager, Panel, SubmitButton } from "@/features/assets/components/shared";
import { ApproveRequestDialog, CompleteMaintenanceDialog, ReasonDialog, ScheduleMaintenanceDialog } from "@/features/assets/components/MaintenanceDialogs";
import { expiryLabel, formatDateTime, formatDay, formatMoney } from "@/features/assets/utils/format";

function Detail({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

const label = (list, value) => list.find((item) => item.value === value)?.label ?? value;

export function OverviewTab({ asset, onSeatAction }) {
  const software = asset.kind === "software";
  const license = asset.license;
  const warranty = expiryLabel(asset.warranty.expiryDate);
  const licenseExpiry = expiryLabel(license?.expiryDate);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Details">
        <dl className="grid grid-cols-2 gap-4">
          <Detail label="Category">{asset.category?.name}</Detail>
          <Detail label="Condition">{conditionLabel(asset.condition)}</Detail>
          <Detail label="Brand">{asset.brand}</Detail>
          <Detail label="Model">{asset.model}</Detail>
          <Detail label="Serial number">{asset.serialNumber}</Detail>
          <Detail label="Asset tag">{asset.assetTag}</Detail>
          <Detail label="Location">{asset.location}</Detail>
          <Detail label="Owning team">{asset.team?.name}</Detail>
          <div className="col-span-2"><Detail label="Description">{asset.description}</Detail></div>
          <div className="col-span-2"><Detail label="Notes">{asset.notes}</Detail></div>
        </dl>
      </Panel>

      <Panel title="Purchase & warranty">
        <dl className="grid grid-cols-2 gap-4">
          <Detail label="Purchased">{formatDay(asset.purchase.date)}</Detail>
          <Detail label="Cost">{asset.purchase.cost !== null ? formatMoney(asset.purchase.cost, asset.purchase.currency) : ""}</Detail>
          <Detail label="Vendor">{asset.purchase.vendor?.name}</Detail>
          <Detail label="Invoice">{asset.purchase.invoiceReference}</Detail>
          {!software ? (
            <>
              <Detail label="Warranty starts">{formatDay(asset.warranty.startDate)}</Detail>
              <Detail label="Warranty">{asset.warranty.expiryDate ? <span>{formatDay(asset.warranty.expiryDate)}{warranty ? <span className={`ml-2 text-xs ${warranty.tone}`}>{warranty.text}</span> : null}</span> : ""}</Detail>
              <Detail label="Next maintenance">{formatDay(asset.maintenance.nextDate)}</Detail>
              <Detail label="Last maintenance">{formatDay(asset.maintenance.lastDate)}</Detail>
            </>
          ) : null}
        </dl>
      </Panel>

      {software && license ? (
        <Panel title="License" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Detail label="Type">{label(LICENSE_TYPES, license.licenseType)}</Detail>
            <Detail label="Seats used">{license.allocatedSeats} of {license.seats} ({license.availableSeats} free)</Detail>
            <Detail label="Expires">{license.expiryDate ? <span>{formatDay(license.expiryDate)}{licenseExpiry ? <span className={`ml-2 text-xs ${licenseExpiry.tone}`}>{licenseExpiry.text}</span> : null}</span> : ""}</Detail>
            <Detail label="Renews">{formatDay(license.renewalDate)}</Detail>
            <Detail label="Key stored at">{license.keyReference !== undefined ? license.keyReference : license.hasKeyReference ? "Recorded (restricted)" : ""}</Detail>
          </dl>
          <SeatHolders asset={asset} onSeatAction={onSeatAction} />
        </Panel>
      ) : null}
    </div>
  );
}

function SeatHolders({ asset, onSeatAction }) {
  const canSee = usePermission(PERMISSIONS.VIEW_ASSETS);
  const canTransfer = usePermission(PERMISSIONS.TRANSFER_ASSET);
  const canReturn = usePermission(PERMISSIONS.RETURN_ASSET);
  const { data } = useAssetHistory(canSee ? asset.id : null, { limit: 100 });
  if (!canSee) return null;
  const holders = (data?.assignments ?? []).filter((row) => row.status === "ACTIVE");
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Seat holders</h3>
      {holders.length === 0 ? <p className="text-sm text-muted-foreground">No seats assigned.</p> : (
        <ul className="divide-y divide-border">
          {holders.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>{row.user?.name}{row.user?.former ? <span className="ml-2 text-xs text-orange-600 dark:text-orange-400">left org</span> : null}<span className="ml-2 text-xs text-muted-foreground">since {formatDay(String(row.assignedAt).slice(0, 10))}</span></span>
              <span className="flex gap-1">
                {canTransfer ? <Button size="sm" variant="ghost" onClick={() => onSeatAction("transfer", row.user.id)}>Move seat</Button> : null}
                {canReturn ? <Button size="sm" variant="ghost" onClick={() => onSeatAction("return", row.user.id)}>Release</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HistoryTab({ asset }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useAssetHistory(asset.id, { page, limit: 15 });
  if (isLoading) return <ListSkeleton rows={4} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data.assignments.length) return <EmptyState title="Never assigned" description="Every assignment, transfer and return will be recorded here." />;
  return (
    <>
      <ol className="space-y-3">
        {data.assignments.map((row) => (
          <li key={row.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {row.user ? row.user.name : row.team?.name}
                  {row.team ? <span className="ml-1 text-xs font-normal text-muted-foreground">(team)</span> : null}
                  {row.user?.former ? <span className="ml-2 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:text-orange-400">no longer in the organization</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">Assigned {formatDateTime(row.assignedAt)}{row.assignedBy ? ` by ${row.assignedBy.name}` : ""}</p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${row.status === "ACTIVE" ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : "bg-muted text-muted-foreground"}`}>
                {row.status === "ACTIVE" ? (row.overdue ? "Active · overdue" : "Active") : row.closeReason === "TRANSFERRED" ? "Transferred" : row.closeReason === "LOST" ? "Lost" : "Returned"}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Detail label="Condition at handover">{conditionLabel(row.conditionAtAssignment)}</Detail>
              <Detail label="Expected return">{formatDay(row.expectedReturnDate)}</Detail>
              <Detail label="Closed">{row.closedAt ? `${formatDateTime(row.closedAt)}${row.closedBy ? ` by ${row.closedBy.name}` : ""}` : ""}</Detail>
              <Detail label="Condition on return">{row.returnedCondition ? conditionLabel(row.returnedCondition) : ""}</Detail>
            </dl>
            {row.notes || row.returnNotes ? <p className="mt-2 text-xs text-muted-foreground">{[row.notes, row.returnNotes].filter(Boolean).join(" · ")}</p> : null}
          </li>
        ))}
      </ol>
      <Pager pagination={data.pagination} onPage={setPage} />
    </>
  );
}

export function MaintenanceTab({ asset }) {
  const { data, isLoading, error, refetch } = useAssetMaintenance(asset.id);
  const action = useMaintenanceAction();
  const [dialog, setDialog] = useState({ type: null, record: null });
  const close = () => setDialog({ type: null, record: null });
  const manage = asset.permissions.canManageMaintenance;
  if (isLoading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const records = data.maintenance;
  const run = (record, name) => action.mutate({ id: asset.id, maintenanceId: record.id, action: name });
  return (
    <div className="space-y-3">
      {manage && asset.kind === "hardware" && !["RETIRED", "DISPOSED"].includes(asset.status) ? (
        <div className="flex justify-end"><Button size="sm" onClick={() => setDialog({ type: "schedule", record: null })}><Plus className="size-4" />Schedule maintenance</Button></div>
      ) : null}
      {records.length === 0 ? <EmptyState title="No maintenance yet" description="Repairs, inspections and requests for this asset will show up here." /> : (
        <ul className="space-y-3">
          {records.map((record) => (
            <li key={record.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{record.issue}</p>
                  <p className="text-xs text-muted-foreground">
                    {label(MAINTENANCE_TYPES, record.type)}
                    {record.reportedBy ? ` · reported by ${record.reportedBy.name}` : ""}
                    {record.scheduledDate ? ` · ${formatDay(record.scheduledDate)}` : ""}
                    {record.serviceProvider ? ` · ${record.serviceProvider}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {record.overdue ? <span className="text-xs font-medium text-destructive">Overdue</span> : null}
                  <MaintenanceBadge status={record.status} />
                </div>
              </div>
              {record.cost !== undefined && record.cost !== null ? <p className="mt-2 text-xs text-muted-foreground">Cost: {formatMoney(record.cost, record.currency)}</p> : null}
              {record.repairNotes ? <p className="mt-1 text-xs text-muted-foreground">{record.repairNotes}</p> : null}
              {record.declineReason ? <p className="mt-1 text-xs text-muted-foreground">Declined: {record.declineReason}</p> : null}
              {manage ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {record.status === "REQUESTED" ? (<><Button size="sm" onClick={() => setDialog({ type: "approve", record })}>Approve</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "decline", record })}>Decline</Button></>) : null}
                  {record.status === "SCHEDULED" ? (<><Button size="sm" onClick={() => run(record, "start")} disabled={action.isPending}>Start</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "cancel", record })}>Cancel</Button></>) : null}
                  {record.status === "IN_PROGRESS" ? (<><Button size="sm" onClick={() => setDialog({ type: "complete", record })}>Complete</Button><Button size="sm" variant="outline" onClick={() => setDialog({ type: "cancel", record })}>Cancel</Button></>) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ScheduleMaintenanceDialog open={dialog.type === "schedule"} onOpenChange={(next) => !next && close()} asset={asset} />
      <ApproveRequestDialog open={dialog.type === "approve"} onOpenChange={(next) => !next && close()} asset={asset} maintenance={dialog.record} />
      <CompleteMaintenanceDialog open={dialog.type === "complete"} onOpenChange={(next) => !next && close()} asset={asset} maintenance={dialog.record} />
      <ReasonDialog open={dialog.type === "decline" || dialog.type === "cancel"} onOpenChange={(next) => !next && close()} asset={asset} maintenance={dialog.record} action={dialog.type === "decline" ? "decline" : "cancel"} />
    </div>
  );
}

function LinkDocumentDialog({ open, onOpenChange, asset }) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 250);
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(linkDocumentSchema), defaultValues: { documentId: "", kind: "invoice" } });
  const { data } = useQuery({ queryKey: ["documents", "picker", debounced], queryFn: () => documentService.list({ search: debounced || undefined, limit: 20 }), enabled: open });
  const link = useLinkDocument();
  const submit = handleSubmit(async (values) => {
    try {
      await link.mutateAsync({ id: asset.id, payload: values });
      reset({ documentId: "", kind: "invoice" });
      setSearch("");
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Dialog open={open} onOpenChange={(next) => !link.isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link a document</DialogTitle>
          <DialogDescription>Pick a file from the Documents library. Nothing is copied, and linking doesn&apos;t change who can open it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Search documents" htmlFor="ld-search"><Input id="ld-search" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" /></Field>
          <Field label="Document *" htmlFor="ld-doc" error={errors.documentId?.message}>
            <NativeSelect id="ld-doc" {...register("documentId")}>
              <option value="">Select a document</option>
              {(data?.documents ?? []).map((doc) => <option key={doc.id} value={doc.id}>{doc.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="What is it?" htmlFor="ld-kind"><NativeSelect id="ld-kind" {...register("kind")}>{DOCUMENT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</NativeSelect></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={link.isPending}>Cancel</Button>
            <SubmitButton pending={link.isPending}>Link document</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentsTab({ asset }) {
  const { data, isLoading, error, refetch } = useAssetDocuments(asset.id);
  const unlink = useUnlinkDocument();
  const [linking, setLinking] = useState(false);
  const canEdit = usePermission(PERMISSIONS.UPDATE_ASSET);
  if (isLoading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-3">
      {canEdit ? <div className="flex justify-end"><Button size="sm" onClick={() => setLinking(true)}><Link2 className="size-4" />Link document</Button></div> : null}
      {data.documents.length === 0 ? <EmptyState icon={FileText} title="No documents linked" description="Link invoices, warranty cards, manuals and photos from the Documents library." /> : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.documents.map((entry) => (
            <li key={entry.linkId} className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{entry.status === "restricted" ? <Lock className="size-4" /> : <FileText className="size-4" />}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {entry.status === "ok" ? entry.document.name : entry.status === "restricted" ? "Restricted document" : "Document no longer available"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {label(DOCUMENT_KINDS, entry.kind)} · linked {formatDateTime(entry.linkedAt)}{entry.linkedBy ? ` by ${entry.linkedBy}` : ""}
                    {entry.status === "restricted" ? " · you don't have access to this file" : ""}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                {entry.status === "ok" ? <Button size="sm" variant="ghost" asChild><Link href={`/dashboard/documents?doc=${entry.documentId}`}><ExternalLink className="size-4" /><span className="sr-only sm:not-sr-only">Open</span></Link></Button> : null}
                {canEdit ? <Button size="icon" variant="ghost" aria-label="Unlink document" disabled={unlink.isPending} onClick={() => unlink.mutate({ id: asset.id, linkId: entry.linkId })}><Trash2 className="size-4" /></Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <LinkDocumentDialog open={linking} onOpenChange={setLinking} asset={asset} />
    </div>
  );
}

function describe(entry) {
  const m = entry.metadata || {};
  return [m.to && `to ${m.to}`, m.action && String(m.action), m.note && String(m.note)].filter(Boolean).join(" · ");
}

export function ActivityTab({ asset }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useAssetActivity(asset.id, { page, limit: 20 });
  if (isLoading) return <ListSkeleton rows={5} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data.activity.length) return <EmptyState title="No activity yet" />;
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {data.activity.map((entry) => (
          <li key={entry.id} className="flex items-start justify-between gap-3 p-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-foreground">{ACTIVITY_LABELS[entry.action] ?? entry.action}</p>
              <p className="text-xs text-muted-foreground">{entry.user ? entry.user.name : "System"}{describe(entry) ? ` · ${describe(entry)}` : ""}</p>
            </div>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </li>
        ))}
      </ul>
      <Pager pagination={data.pagination} onPage={setPage} />
    </>
  );
}
