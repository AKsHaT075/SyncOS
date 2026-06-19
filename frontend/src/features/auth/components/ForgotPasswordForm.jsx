"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthPageShell from "@/features/auth/components/AuthPageShell";
import { forgotPasswordSchema } from "@/features/auth/schemas/authSchemas";
import { useForgotPassword } from "@/features/auth/hooks/useForgotPassword";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function ForgotPasswordForm() {
  const mutation = useForgotPassword();
  const form = useForm({
    defaultValues: { email: "" },
    resolver: zodResolver(forgotPasswordSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
    } catch (error) {
      // handled by hook
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <AuthPageShell
      title="Reset your password"
      description="We will send a reset link to your email address."
      footer={<span><a className="text-cyan-300 underline-offset-4 hover:underline" href="/login">Back to sign in</a></span>}
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="email">Email</label>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...form.register("email")} />
          {form.formState.errors.email ? <p className="text-sm text-rose-400">{form.formState.errors.email.message}</p> : null}
        </div>

        {errorMessage ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{errorMessage}</p> : null}

        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Sending link..." : "Send reset link"}
        </Button>
      </form>
    </AuthPageShell>
  );
}
