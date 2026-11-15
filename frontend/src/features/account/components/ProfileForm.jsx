"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useAuthStore } from "@/store/useAuthStore";
import { parseSkills, profileSchema } from "@/features/account/schemas/accountSchemas";
import { useUpdateProfile } from "@/features/account/hooks/accountHooks";
import Field from "@/features/account/components/Field";

export default function ProfileForm() {
  const user = useAuthStore((state) => state.user);
  const mutation = useUpdateProfile();
  const form = useForm({ resolver: zodResolver(profileSchema), mode: "onTouched", defaultValues: { firstName: "", lastName: "", skills: "" } });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (user) reset({ firstName: user.firstName ?? "", lastName: user.lastName ?? "", skills: (user.skills ?? []).join(", ") });
  }, [user, reset]);

  const onSubmit = (values) => mutation.mutate({ firstName: values.firstName, lastName: values.lastName, skills: parseSkills(values.skills) });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Profile</h2>
      <p className="mb-4 text-xs text-muted-foreground">Your name and skills are visible to colleagues who can see you in the directory. Your email and role are managed elsewhere.</p>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="firstName" label="First name" error={formState.errors.firstName?.message}>
            <Input id="firstName" autoComplete="given-name" {...register("firstName")} />
          </Field>
          <Field id="lastName" label="Last name" error={formState.errors.lastName?.message}>
            <Input id="lastName" autoComplete="family-name" {...register("lastName")} />
          </Field>
        </div>
        <Field id="email" label="Email" hint="Your sign-in email cannot be changed here.">
          <Input id="email" value={user?.email ?? ""} readOnly disabled />
        </Field>
        <Field id="skills" label="Skills" hint="Comma separated, up to 50." error={formState.errors.skills?.message}>
          <Input id="skills" placeholder="Design, Backend, Hiring" {...register("skills")} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending || !formState.isDirty}>{mutation.isPending ? "Saving…" : "Save profile"}</Button>
        </div>
      </form>
    </Card>
  );
}
