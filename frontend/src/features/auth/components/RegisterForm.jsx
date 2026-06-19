"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthPageShell from "@/features/auth/components/AuthPageShell";
import { registerSchema } from "@/features/auth/schemas/authSchemas";
import { useRegister } from "@/features/auth/hooks/useRegister";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function RegisterForm() {
  const router = useRouter();
  const mutation = useRegister();
  const form = useForm({
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      password: "",
    },
    resolver: zodResolver(registerSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      router.push(`/verify-email?email=${encodeURIComponent(values.email)}`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <AuthPageShell
      title="Create your account"
      description="Start a secure Sync Os workspace and verify your email to continue."
      footer={
        <span>
          Already have an account? <a className="text-cyan-300 underline-offset-4 hover:underline" href="/login">Sign in</a>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-200" htmlFor="firstName">First name</label>
            <Input id="firstName" autoComplete="given-name" placeholder="Ava" {...form.register("firstName")} />
            {form.formState.errors.firstName ? <p className="text-sm text-rose-400">{form.formState.errors.firstName.message}</p> : null}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-200" htmlFor="lastName">Last name</label>
            <Input id="lastName" autoComplete="family-name" placeholder="Patel" {...form.register("lastName")} />
            {form.formState.errors.lastName ? <p className="text-sm text-rose-400">{form.formState.errors.lastName.message}</p> : null}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="email">Email</label>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...form.register("email")} />
          {form.formState.errors.email ? <p className="text-sm text-rose-400">{form.formState.errors.email.message}</p> : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="password">Password</label>
          <Input id="password" type="password" autoComplete="new-password" placeholder="Create a secure password" {...form.register("password")} />
          {form.formState.errors.password ? <p className="text-sm text-rose-400">{form.formState.errors.password.message}</p> : null}
        </div>

        {errorMessage ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{errorMessage}</p> : null}

        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating account..." : "Create account"}
        </Button>
      </form>
    </AuthPageShell>
  );
}
