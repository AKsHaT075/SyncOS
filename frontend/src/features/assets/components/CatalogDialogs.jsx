"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useArchiveCategory, useCategories, useCreateCategory, useCreateVendor, useUpdateCategory, useUpdateVendor } from "@/features/assets/hooks/assetHooks";
import { nameSchema, vendorSchema } from "@/features/assets/schemas/assetSchemas";
import { Field, NativeSelect, SubmitButton } from "@/features/assets/components/shared";

function Shell({ open, onOpenChange, pending, title, description, onSubmit, submitLabel, children, destructive }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription>{description}</DialogDescription> : null}</DialogHeader>
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

export function CategoryDialog({ open, onOpenChange, category = null }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(nameSchema), defaultValues: { name: "", description: "" } });
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const pending = create.isPending || update.isPending;
  useEffect(() => { if (open) reset({ name: category?.name ?? "", description: category?.description ?? "" }); }, [open, category, reset]);
  const submit = handleSubmit(async (values) => {
    try {
      if (category) await update.mutateAsync({ id: category.id, payload: values });
      else await create.mutateAsync(values);
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={pending} title={category ? "Rename category" : "New category"} onSubmit={submit} submitLabel={category ? "Save" : "Create"}>
      <Field label="Name *" htmlFor="cat-name" error={errors.name?.message}><Input id="cat-name" autoFocus {...register("name")} /></Field>
      <Field label="Description" htmlFor="cat-desc" error={errors.description?.message}><Textarea id="cat-desc" rows={2} {...register("description")} /></Field>
    </Shell>
  );
}

/** Archiving a category with assets requires choosing where they go, so nothing is ever left without a category. */
export function ArchiveCategoryDialog({ open, onOpenChange, category }) {
  const { register, handleSubmit, reset } = useForm({ defaultValues: { moveTo: "" } });
  const { data } = useCategories();
  const archive = useArchiveCategory();
  useEffect(() => { if (open) reset({ moveTo: "" }); }, [open, reset]);
  const needsTarget = (category?.assetCount ?? 0) > 0;
  const options = (data?.categories ?? []).filter((c) => c.id !== category?.id);
  const submit = handleSubmit(async (values) => {
    try {
      await archive.mutateAsync({ id: category.id, payload: values.moveTo ? { moveTo: values.moveTo } : {} });
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={archive.isPending} title="Archive category" description={category ? `“${category.name}” will no longer be offered for new assets.` : ""} onSubmit={submit} submitLabel="Archive" destructive>
      {needsTarget ? (
        <Field label={`Move its ${category.assetCount} asset${category.assetCount === 1 ? "" : "s"} to *`} htmlFor="ac-move">
          <NativeSelect id="ac-move" required {...register("moveTo")}>
            <option value="">Select a category</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
      ) : <p className="text-sm text-muted-foreground">No assets use this category.</p>}
    </Shell>
  );
}

export function VendorDialog({ open, onOpenChange, vendor = null }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(vendorSchema), defaultValues: { name: "", contactPerson: "", email: "", phone: "", website: "", notes: "" } });
  const create = useCreateVendor();
  const update = useUpdateVendor();
  const pending = create.isPending || update.isPending;
  useEffect(() => {
    if (open) reset({ name: vendor?.name ?? "", contactPerson: vendor?.contactPerson ?? "", email: vendor?.email ?? "", phone: vendor?.phone ?? "", website: vendor?.website ?? "", notes: vendor?.notes ?? "" });
  }, [open, vendor, reset]);
  const submit = handleSubmit(async (values) => {
    try {
      if (vendor) await update.mutateAsync({ id: vendor.id, payload: values });
      else await create.mutateAsync(values);
      onOpenChange(false);
    } catch { /* toast shown */ }
  });
  return (
    <Shell open={open} onOpenChange={onOpenChange} pending={pending} title={vendor ? "Edit vendor" : "Add vendor"} onSubmit={submit} submitLabel={vendor ? "Save" : "Add vendor"}>
      <Field label="Name *" htmlFor="v-name" error={errors.name?.message}><Input id="v-name" autoFocus {...register("name")} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact person" htmlFor="v-contact"><Input id="v-contact" {...register("contactPerson")} /></Field>
        <Field label="Phone" htmlFor="v-phone"><Input id="v-phone" {...register("phone")} /></Field>
        <Field label="Email" htmlFor="v-email" error={errors.email?.message}><Input id="v-email" type="email" {...register("email")} /></Field>
        <Field label="Website" htmlFor="v-web" error={errors.website?.message}><Input id="v-web" placeholder="https://" {...register("website")} /></Field>
      </div>
      <Field label="Notes" htmlFor="v-notes"><Textarea id="v-notes" rows={2} {...register("notes")} /></Field>
    </Shell>
  );
}
