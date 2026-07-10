"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { joinOrganizationSchema } from "@/features/organization/schemas/organizationSchemas";
import { extractInviteToken } from "@/features/organization/services/organizationService";
import { useJoinOrganization } from "@/features/organization/hooks/useJoinOrganization";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function JoinOrganizationPage() {
  const router = useRouter();
  const mutation = useJoinOrganization();
  const form = useForm({
    defaultValues: { token: "" },
    resolver: zodResolver(joinOrganizationSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(extractInviteToken(values.token));
      router.push("/dashboard");
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Join an organization</CardTitle>
        <CardDescription>Paste your invite code or invitation link.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="token">Invite code or link</label>
            <Input id="token" placeholder="Paste your invite code or link" {...form.register("token")} />
            {form.formState.errors.token ? (
              <p className="text-sm text-destructive">{form.formState.errors.token.message}</p>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Joining..." : "Join Organization"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
