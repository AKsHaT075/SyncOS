"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthPageShell from "@/features/auth/components/AuthPageShell";
import { loginSchema } from "@/features/auth/schemas/authSchemas";
import { useLogin } from "@/features/auth/hooks/useLogin";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function LoginForm() {
  const router = useRouter();
  const mutation = useLogin();
  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    resolver: zodResolver(loginSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      router.push("/dashboard");
    } catch (error) {
      // handled by mutation toast; keep local fallback for inline error state
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <AuthPageShell
      title="Sign in"
      description="Use your SynapseOS credentials to access your workspace."
      footer={
        <span>
          New here? <a className="text-cyan-300 underline-offset-4 hover:underline" href="/register">Create an account</a>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="email">Email</label>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...form.register("email")} />
          {form.formState.errors.email ? <p className="text-sm text-rose-400">{form.formState.errors.email.message}</p> : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200" htmlFor="password">Password</label>
          <Input id="password" type="password" autoComplete="current-password" placeholder="••••••••" {...form.register("password")} />
          {form.formState.errors.password ? <p className="text-sm text-rose-400">{form.formState.errors.password.message}</p> : null}
        </div>

        {errorMessage ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{errorMessage}</p> : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button type="submit" className="w-full sm:w-auto" disabled={mutation.isPending}>
            {mutation.isPending ? "Signing in..." : "Sign in"}
          </Button>
          <a className="text-sm text-slate-300 underline-offset-4 hover:text-cyan-300 hover:underline" href="/forgot-password">
            Forgot password?
          </a>
        </div>
      </form>
    </AuthPageShell>
  );
}
