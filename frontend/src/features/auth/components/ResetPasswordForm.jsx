"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthPageShell from "@/features/auth/components/AuthPageShell";
import { resetPasswordSchema } from "@/features/auth/schemas/authSchemas";
import { useResetPassword } from "@/features/auth/hooks/useResetPassword";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function ResetPasswordForm({ initialEmail = "", initialToken = "" }) {
  const router = useRouter();
  const mutation = useResetPassword();
  const form = useForm({
    defaultValues: {
      email: initialEmail,
      password: "",
      token: initialToken,
    },
    resolver: zodResolver(resetPasswordSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      router.push("/login");
    } catch (error) {
      // hook handles toast
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <AuthPageShell
      title="Set a new password"
      description="Use the token from your reset email to finish the password reset."
      footer={<span><a className="text-cyan-300 underline-offset-4 hover:underline" href="/login">Back to sign in</a></span>}
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="email">Email</label>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...form.register("email")} />
          {form.formState.errors.email ? <p className="text-sm text-rose-400">{form.formState.errors.email.message}</p> : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="token">Reset token</label>
          <Input id="token" autoComplete="off" placeholder="Paste token from email" {...form.register("token")} />
          {form.formState.errors.token ? <p className="text-sm text-rose-400">{form.formState.errors.token.message}</p> : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="password">New password</label>
          <Input id="password" type="password" autoComplete="new-password" placeholder="Create a secure password" {...form.register("password")} />
          {form.formState.errors.password ? <p className="text-sm text-rose-400">{form.formState.errors.password.message}</p> : null}
        </div>

        {errorMessage ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{errorMessage}</p> : null}

        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Updating password..." : "Reset password"}
        </Button>
      </form>
    </AuthPageShell>
  );
}
