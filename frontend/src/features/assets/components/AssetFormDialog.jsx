"use client";

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CONDITIONS, CURRENCIES, KINDS, LICENSE_TYPES } from "@/features/assets/constants/assetOptions";
import { useCategories, useCreateAsset, useUpdateAsset } from "@/features/assets/hooks/assetHooks";
import { assetFormSchema } from "@/features/assets/schemas/assetSchemas";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { PERMISSIONS } from "@/constants/permissions";
import { compact } from "@/features/assets/utils/format";
import { Field, NativeSelect, SubmitButton } from "@/features/assets/components/shared";

const EMPTY = {
  name: "", kind: "hardware", categoryId: "", assetTag: "", serialNumber: "", brand: "", model: "", description: "", location: "", teamId: "",
  condition: "GOOD", purchaseDate: "", cost: "", currency: "INR", invoiceReference: "", warrantyStart: "", warrantyExpiry: "", notes: "",
  licenseType: "PER_SEAT", seats: "1", licenseStart: "", licenseExpiry: "", licenseRenewal: "", keyReference: "",
};

const fromAsset = (asset) => ({
  ...EMPTY,
  name: asset.name, kind: asset.kind, categoryId: asset.category?.id ?? "", assetTag: asset.assetTag, serialNumber: asset.serialNumber, brand: asset.brand,
  model: asset.model, description: asset.description, location: asset.location, teamId: asset.team?.id ?? "", condition: asset.condition,
  purchaseDate: asset.purchase.date ?? "", cost: asset.purchase.cost ?? "", currency: asset.purchase.currency ?? "INR",
  invoiceReference: asset.purchase.invoiceReference, warrantyStart: asset.warranty.startDate ?? "", warrantyExpiry: asset.warranty.expiryDate ?? "", notes: asset.notes,
  ...(asset.license
    ? {
        licenseType: asset.license.licenseType ?? "PER_SEAT", seats: String(asset.license.seats), licenseStart: asset.license.startDate ?? "",
        licenseExpiry: asset.license.expiryDate ?? "", licenseRenewal: asset.license.renewalDate ?? "", keyReference: asset.license.keyReference ?? "",
      }
    : {}),
});

/** Create (no `asset`) or edit an asset. Status is never edited here — it only changes through lifecycle actions. */
export default function AssetFormDialog({ open, onOpenChange, asset = null }) {
  const editing = Boolean(asset);
  const form = useForm({ resolver: zodResolver(assetFormSchema), defaultValues: EMPTY });
  const { register, handleSubmit, reset, control, formState: { errors } } = form;
  const kind = useWatch({ control, name: "kind" });
  const { data: categories } = useCategories();
  const { data: teams } = useTeams({ limit: 100 });
  const canLicense = usePermission(PERMISSIONS.MANAGE_ASSET_LICENSES);
  const create = useCreateAsset();
  const update = useUpdateAsset();
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (open) reset(asset ? fromAsset(asset) : EMPTY);
  }, [open, asset, reset]);

  const submit = async (values) => {
    const software = values.kind === "software";
    const body = {
      name: values.name,
      categoryId: values.categoryId,
      ...compact({
        assetTag: values.assetTag, serialNumber: values.serialNumber, brand: values.brand, model: values.model, description: values.description,
        location: values.location, notes: values.notes,
      }),
      teamId: values.teamId || null,
      condition: values.condition,
      purchase: {
        date: values.purchaseDate || null, cost: values.cost === "" ? null : Number(values.cost), currency: values.currency,
        invoiceReference: values.invoiceReference || "",
      },
      warranty: software ? undefined : { startDate: values.warrantyStart || null, expiryDate: values.warrantyExpiry || null },
      license: software
        ? {
            licenseType: values.licenseType, seats: Number(values.seats), startDate: values.licenseStart || null,
            expiryDate: values.licenseExpiry || null, renewalDate: values.licenseRenewal || null,
            ...(canLicense ? { keyReference: values.keyReference } : {}),
          }
        : undefined,
    };
    try {
      if (editing) await update.mutateAsync({ id: asset.id, updates: body });
      else await create.mutateAsync({ ...body, kind: values.kind });
      onOpenChange(false);
    } catch {
      /* toast already shown; keep the dialog open so nothing typed is lost */
    }
  };

  const err = (name) => errors[name]?.message;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit asset" : "Add asset"}</DialogTitle>
          <DialogDescription>{editing ? `${asset.assetId} · status changes happen through actions on the asset page.` : "Add equipment or a software license to the inventory."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name *" htmlFor="af-name" error={err("name")} className="sm:col-span-2">
              <Input id="af-name" autoFocus placeholder="e.g. MacBook Pro 14”" aria-invalid={Boolean(err("name"))} {...register("name")} />
            </Field>
            <Field label="Type" htmlFor="af-kind">
              <NativeSelect id="af-kind" disabled={editing} {...register("kind")}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</NativeSelect>
            </Field>
            <Field label="Category *" htmlFor="af-category" error={err("categoryId")}>
              <NativeSelect id="af-category" {...register("categoryId")}>
                <option value="">Select a category</option>
                {(categories?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Asset tag" htmlFor="af-tag" error={err("assetTag")} hint="Your own label, e.g. a sticker number. Must be unique."><Input id="af-tag" {...register("assetTag")} /></Field>
            {kind === "hardware" ? <Field label="Serial number" htmlFor="af-serial" error={err("serialNumber")}><Input id="af-serial" {...register("serialNumber")} /></Field> : null}
            <Field label="Brand" htmlFor="af-brand"><Input id="af-brand" {...register("brand")} /></Field>
            <Field label="Model" htmlFor="af-model"><Input id="af-model" {...register("model")} /></Field>
            <Field label="Location" htmlFor="af-location"><Input id="af-location" placeholder="Office, floor, remote…" {...register("location")} /></Field>
            <Field label="Owning team" htmlFor="af-team" hint="Optional. A team-owned asset can be assigned by that team's manager.">
              <NativeSelect id="af-team" {...register("teamId")}>
                <option value="">No team</option>
                {(teams?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Condition" htmlFor="af-condition">
              <NativeSelect id="af-condition" {...register("condition")}>{CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</NativeSelect>
            </Field>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">Purchase</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Date" htmlFor="af-pdate" error={err("purchaseDate")}><Input id="af-pdate" type="date" {...register("purchaseDate")} /></Field>
              <Field label="Cost" htmlFor="af-cost" error={err("cost")}><Input id="af-cost" inputMode="decimal" {...register("cost")} /></Field>
              <Field label="Currency" htmlFor="af-currency"><NativeSelect id="af-currency" {...register("currency")}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Invoice reference" htmlFor="af-invoice" className="sm:col-span-3"><Input id="af-invoice" {...register("invoiceReference")} /></Field>
            </div>
          </fieldset>

          {kind === "hardware" ? (
            <fieldset className="space-y-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Warranty</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" htmlFor="af-wstart" error={err("warrantyStart")}><Input id="af-wstart" type="date" {...register("warrantyStart")} /></Field>
                <Field label="Expires" htmlFor="af-wend" error={err("warrantyExpiry")}><Input id="af-wend" type="date" {...register("warrantyExpiry")} /></Field>
              </div>
            </fieldset>
          ) : (
            <fieldset className="space-y-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">License</legend>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="License type" htmlFor="af-ltype"><NativeSelect id="af-ltype" {...register("licenseType")}>{LICENSE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</NativeSelect></Field>
                <Field label="Seats *" htmlFor="af-seats" error={err("seats")}><Input id="af-seats" inputMode="numeric" {...register("seats")} /></Field>
                <span className="hidden sm:block" />
                <Field label="Starts" htmlFor="af-lstart" error={err("licenseStart")}><Input id="af-lstart" type="date" {...register("licenseStart")} /></Field>
                <Field label="Expires" htmlFor="af-lend" error={err("licenseExpiry")}><Input id="af-lend" type="date" {...register("licenseExpiry")} /></Field>
                <Field label="Renews" htmlFor="af-lren"><Input id="af-lren" type="date" {...register("licenseRenewal")} /></Field>
              </div>
              {canLicense ? (
                <Field label="Where the key is stored" htmlFor="af-key" error={err("keyReference")} hint="A pointer only (e.g. “1Password › IT › Figma”). Never paste the key or password itself.">
                  <Input id="af-key" autoComplete="off" {...register("keyReference")} />
                </Field>
              ) : null}
            </fieldset>
          )}

          <Field label="Description" htmlFor="af-desc"><Textarea id="af-desc" rows={2} {...register("description")} /></Field>
          <Field label="Notes" htmlFor="af-notes" error={err("notes")}><Textarea id="af-notes" rows={2} {...register("notes")} /></Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <SubmitButton pending={pending}>{editing ? "Save changes" : "Add asset"}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
