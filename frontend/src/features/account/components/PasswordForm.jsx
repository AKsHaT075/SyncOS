"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { passwordSchema } from "@/features/account/schemas/accountSchemas";
import { useChangePassword } from "@/features/account/hooks/accountHooks";
import Field from "@/features/account/components/Field";

export default function PasswordForm() {
  const mutation = useChangePassword();
  const { register, handleSubmit, formState } = useForm({
    resolver: zodResolver(passwordSchema),
    mode: "onTouched",
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const onSubmit = ({ currentPassword, newPassword }) => mutation.mutate({ currentPassword, newPassword });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Password</h2>
      <p className="mb-4 text-xs text-muted-foreground">Changing your password signs you out on every device, including this one.</p>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id="currentPassword" label="Current password" error={formState.errors.currentPassword?.message}>
          <Input id="currentPassword" type="password" autoComplete="current-password" {...register("currentPassword")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="newPassword" label="New password" hint="8+ characters with upper, lower case and a number." error={formState.errors.newPassword?.message}>
            <Input id="newPassword" type="password" autoComplete="new-password" {...register("newPassword")} />
          </Field>
          <Field id="confirmPassword" label="Repeat new password" error={formState.errors.confirmPassword?.message}>
            <Input id="confirmPassword" type="password" autoComplete="new-password" {...register("confirmPassword")} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Changing…" : "Change password"}</Button>
        </div>
      </form>
    </Card>
  );
}
