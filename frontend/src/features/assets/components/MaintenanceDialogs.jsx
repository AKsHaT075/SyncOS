"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CONDITIONS, CURRENCIES, MAINTENANCE_TYPES } from "@/features/assets/constants/assetOptions";
import { useCreateMaintenance, useMaintenanceAction, useReportIssue, useVendors } from "@/features/assets/hooks/assetHooks";
import { approveSchema, completeMaintenanceSchema, issueSchema, maintenanceSchema } from "@/features/assets/schemas/assetSchemas";
import { compact, todayString } from "@/features/assets/utils/format";
import { Field, NativeSelect, SubmitButton } from "@/features/assets/components/shared";

function Shell({ open, onOpenChange, pending, title, description, onSubmit, submitLabel, children, destructive }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <SubmitButton pending={pending} variant={destructive ? "destructive" : "default"}>{submitLabel}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An employee (or manager) reports a problem with equipment they hold. It waits for approval as a request. */
export function ReportIssueDialog({ open, onOpenChange, asset }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(issueSchema), defaultValues: { issue: "", type: "REPAIR" } });
  const mutation = useReportIssue();
  useEffect(() => { if (open) reset({ issue: "", type: "REPAIR" }); }, [open, reset]);
  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({ id: asset.id, payload: { issue: values.issue, type: values.type } });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={mutation.isPending} title="Report a problem" description={asset ? `${asset.name} · ${asset.assetId}. The asset team will review your request.` : ""} onSubmit={submit} submitLabel="Send report">
      <Field label="What kind of help?" htmlFor="ri-type"><NativeSelect id="ri-type" {...register("type")}>{MAINTENANCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</NativeSelect></Field>
      <Field label="What's wrong? *" htmlFor="ri-issue" error={errors.issue?.message}><Textarea id="ri-issue" rows={4} autoFocus {...register("issue")} /></Field>
    </Shell>
  );
}

export function ScheduleMaintenanceDialog({ open, onOpenChange, asset }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(maintenanceSchema), defaultValues: { type: "REPAIR", issue: "", scheduledDate: todayString(), serviceProvider: "", vendorId: "" } });
  const { data: vendors } = useVendors();
  const mutation = useCreateMaintenance();
  useEffect(() => { if (open) reset({ type: "REPAIR", issue: "", scheduledDate: todayString(), serviceProvider: "", vendorId: "" }); }, [open, reset]);
  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({ id: asset.id, payload: { ...compact({ serviceProvider: values.serviceProvider }), type: values.type, issue: values.issue, scheduledDate: values.scheduledDate, vendorId: values.vendorId || null } });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={mutation.isPending} title="Schedule maintenance" description={asset ? `${asset.name} · ${asset.assetId}` : ""} onSubmit={submit} submitLabel="Schedule">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="sm-type"><NativeSelect id="sm-type" {...register("type")}>{MAINTENANCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</NativeSelect></Field>
        <Field label="Date *" htmlFor="sm-date" error={errors.scheduledDate?.message}><Input id="sm-date" type="date" {...register("scheduledDate")} /></Field>
      </div>
      <Field label="Work to be done *" htmlFor="sm-issue" error={errors.issue?.message}><Textarea id="sm-issue" rows={3} {...register("issue")} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" htmlFor="sm-vendor"><NativeSelect id="sm-vendor" {...register("vendorId")}><option value="">None</option>{(vendors?.vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</NativeSelect></Field>
        <Field label="Service provider" htmlFor="sm-provider"><Input id="sm-provider" {...register("serviceProvider")} /></Field>
      </div>
    </Shell>
  );
}

export function ApproveRequestDialog({ open, onOpenChange, asset, maintenance }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(approveSchema), defaultValues: { scheduledDate: todayString(), serviceProvider: "" } });
  const mutation = useMaintenanceAction();
  useEffect(() => { if (open) reset({ scheduledDate: todayString(), serviceProvider: "" }); }, [open, reset]);
  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({ id: asset.id, maintenanceId: maintenance.id, action: "approve", payload: { scheduledDate: values.scheduledDate, ...compact({ serviceProvider: values.serviceProvider }) } });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={mutation.isPending} title="Approve request" description={maintenance ? `“${maintenance.issue}”` : ""} onSubmit={submit} submitLabel="Approve & schedule">
      <Field label="Schedule for *" htmlFor="ap-date" error={errors.scheduledDate?.message}><Input id="ap-date" type="date" {...register("scheduledDate")} /></Field>
      <Field label="Service provider" htmlFor="ap-provider"><Input id="ap-provider" {...register("serviceProvider")} /></Field>
    </Shell>
  );
}

export function CompleteMaintenanceDialog({ open, onOpenChange, asset, maintenance }) {
  const defaults = { cost: "", currency: asset?.purchase?.currency ?? "INR", repairNotes: "", condition: "", nextMaintenanceDate: "" };
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(completeMaintenanceSchema), defaultValues: defaults });
  const mutation = useMaintenanceAction();
  useEffect(() => { if (open) reset(defaults); }, [open]);
  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({
        id: asset.id, maintenanceId: maintenance.id, action: "complete",
        payload: { ...compact({ repairNotes: values.repairNotes, condition: values.condition, nextMaintenanceDate: values.nextMaintenanceDate }), ...(values.cost !== "" ? { cost: Number(values.cost), currency: values.currency } : {}) },
      });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={mutation.isPending} title="Complete maintenance" description={maintenance ? `“${maintenance.issue}”` : ""} onSubmit={submit} submitLabel="Mark complete">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Cost" htmlFor="cm-cost" error={errors.cost?.message} className="sm:col-span-2"><Input id="cm-cost" inputMode="decimal" {...register("cost")} /></Field>
        <Field label="Currency" htmlFor="cm-currency"><NativeSelect id="cm-currency" {...register("currency")}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</NativeSelect></Field>
      </div>
      <Field label="Condition after" htmlFor="cm-condition"><NativeSelect id="cm-condition" {...register("condition")}><option value="">Unchanged</option>{CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</NativeSelect></Field>
      <Field label="Next maintenance due" htmlFor="cm-next"><Input id="cm-next" type="date" {...register("nextMaintenanceDate")} /></Field>
      <Field label="Notes" htmlFor="cm-notes"><Textarea id="cm-notes" rows={3} {...register("repairNotes")} /></Field>
    </Shell>
  );
}

/** Decline a request / cancel a scheduled or in-progress job, with an optional reason. */
export function ReasonDialog({ open, onOpenChange, asset, maintenance, action }) {
  const { register, handleSubmit, reset } = useForm({ defaultValues: { reason: "" } });
  const mutation = useMaintenanceAction();
  useEffect(() => { if (open) reset({ reason: "" }); }, [open, reset]);
  const decline = action === "decline";
  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({ id: asset.id, maintenanceId: maintenance.id, action, payload: values.reason.trim() ? { reason: values.reason.trim() } : {} });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={mutation.isPending} title={decline ? "Decline request" : "Cancel maintenance"} description={maintenance ? `“${maintenance.issue}”` : ""} onSubmit={submit} submitLabel={decline ? "Decline" : "Cancel maintenance"} destructive>
      <Field label={decline ? "Reason (shared with the requester)" : "Reason (optional)"} htmlFor="rd-reason"><Textarea id="rd-reason" rows={3} maxLength={500} {...register("reason")} /></Field>
    </Shell>
  );
}
