"use client";

import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useAuthStore } from "@/store/useAuthStore";
import { organizationSchema } from "@/features/account/schemas/accountSchemas";
import { useUpdateOrganization } from "@/features/account/hooks/accountHooks";
import Field from "@/features/account/components/Field";

function timeZones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Kolkata", "UTC"];
  }
}

/** Organization owner only. The page decides who sees this; the API enforces it. */
export default function OrganizationForm() {
  const organization = useAuthStore((state) => state.organizationDetails);
  const mutation = useUpdateOrganization();
  const zones = useMemo(timeZones, []);
  const { register, handleSubmit, reset, formState } = useForm({
    resolver: zodResolver(organizationSchema),
    mode: "onTouched",
    defaultValues: { name: "", logo: "", timeZone: "" },
  });

  useEffect(() => {
    if (organization) reset({ name: organization.name ?? "", logo: organization.logo ?? "", timeZone: organization.timeZone ?? "" });
  }, [organization, reset]);

  const onSubmit = (values) => {
    const payload = { name: values.name };
    payload.logo = values.logo ? values.logo : null;
    if (values.timeZone) payload.timeZone = values.timeZone;
    mutation.mutate(payload);
  };

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Organization</h2>
      <p className="mb-4 text-xs text-muted-foreground">Only the organization owner can change these. The time zone is the default for people who have not set their own (calendar and reminders).</p>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id="orgName" label="Name" error={formState.errors.name?.message}>
          <Input id="orgName" {...register("name")} />
        </Field>
        <Field id="orgLogo" label="Logo URL" hint="Optional. A link to an image." error={formState.errors.logo?.message}>
          <Input id="orgLogo" type="url" placeholder="https://" {...register("logo")} />
        </Field>
        <Field id="orgTimeZone" label="Default time zone" hint="Defaults to Asia/Kolkata when not set." error={formState.errors.timeZone?.message}>
          <Input id="orgTimeZone" list="timezone-options" placeholder="Asia/Kolkata" {...register("timeZone")} />
          <datalist id="timezone-options">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending || !formState.isDirty}>{mutation.isPending ? "Saving…" : "Save organization"}</Button>
        </div>
      </form>
    </Card>
  );
}
