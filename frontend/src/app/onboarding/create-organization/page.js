"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createOrganizationSchema } from "@/features/organization/schemas/organizationSchemas";
import { useCreateOrganization } from "@/features/organization/hooks/useCreateOrganization";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export default function CreateOrganizationPage() {
  const router = useRouter();
  const mutation = useCreateOrganization();
  const form = useForm({
    defaultValues: { name: "", slug: "", logo: "" },
    resolver: zodResolver(createOrganizationSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      router.push("/dashboard");
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Create your organization</CardTitle>
        <CardDescription>You'll become the organization admin.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="name">Organization name</label>
            <Input id="name" placeholder="Acme Inc." {...form.register("name")} />
            {form.formState.errors.name ? (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="slug">Slug (optional)</label>
            <Input id="slug" placeholder="acme-inc" {...form.register("slug")} />
            {form.formState.errors.slug ? (
              <p className="text-sm text-destructive">{form.formState.errors.slug.message}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Leave blank to generate one automatically.</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="logo">Logo URL (optional)</label>
            <Input id="logo" placeholder="https://example.com/logo.png" {...form.register("logo")} />
            {form.formState.errors.logo ? (
              <p className="text-sm text-destructive">{form.formState.errors.logo.message}</p>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating..." : "Create Organization"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
