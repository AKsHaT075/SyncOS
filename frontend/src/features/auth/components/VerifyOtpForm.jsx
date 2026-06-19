"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AuthPageShell from "@/features/auth/components/AuthPageShell";
import { verifyEmailSchema } from "@/features/auth/schemas/authSchemas";
import { useVerifyEmail } from "@/features/auth/hooks/useVerifyEmail";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function VerifyOtpForm({ initialEmail = "" }) {
  const router = useRouter();
  const mutation = useVerifyEmail();
  const form = useForm({
    defaultValues: {
      email: initialEmail,
      otp: "",
    },
    resolver: zodResolver(verifyEmailSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      router.push("/login");
    } catch (error) {
      // toast handled by hook
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <AuthPageShell
      title="Verify your email"
      description="Enter the 6-digit OTP sent to your inbox."
      footer={
        <span>
          Did not get the code? <a className="text-cyan-300 underline-offset-4 hover:underline" href="/login">Return to sign in</a>
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
          <label className="text-sm font-medium text-slate-200" htmlFor="otp">OTP</label>
          <Input id="otp" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" {...form.register("otp")} />
          {form.formState.errors.otp ? <p className="text-sm text-rose-400">{form.formState.errors.otp.message}</p> : null}
        </div>

        {errorMessage ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{errorMessage}</p> : null}

        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Verifying..." : "Verify email"}
        </Button>
      </form>
    </AuthPageShell>
  );
}
