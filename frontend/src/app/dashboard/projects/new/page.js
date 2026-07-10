"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createProjectSchema } from "@/features/projects/schemas/projectSchemas";
import { useCreateProject } from "@/features/projects/hooks/useCreateProject";
import { getFriendlyErrorMessage } from "@/lib/error-message";
import {
  PROJECT_PRIORITIES,
  PROJECT_VISIBILITIES,
  PROJECT_TYPES,
  PROJECT_TYPE_RESOURCE_LINK,
} from "@/features/projects/constants/projectOptions";

const DEFAULT_VALUES = {
  name: "",
  description: "",
  type: "Technical",
  isInternal: false,
  client: "",
  budget: "",
  resourceLink: "",
  priority: "Medium",
  visibility: "Team",
  startDate: "",
  dueDate: "",
};

export default function NewProjectPage() {
  const router = useRouter();
  const mutation = useCreateProject();
  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    resolver: zodResolver(createProjectSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();

    const payload = {
      ...values,
      description: values.description || undefined,
      client: values.isInternal ? undefined : values.client || undefined,
      budget: values.budget !== "" ? Number(values.budget) : undefined,
      resourceLink: values.resourceLink || undefined,
      startDate: values.startDate || undefined,
      dueDate: values.dueDate || undefined,
    };

    try {
      const result = await mutation.mutateAsync(payload);
      router.push(`/dashboard/projects/${result.project.id}`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;
  const { errors } = form.formState;
  const selectedType = form.watch("type");
  const isInternal = form.watch("isInternal");
  const resourceLinkMeta = PROJECT_TYPE_RESOURCE_LINK[selectedType] || PROJECT_TYPE_RESOURCE_LINK.Other;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Link
        href="/dashboard/projects"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back to projects
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">New project</CardTitle>
          <CardDescription>Set up the basics — you can change all of this later.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="name">
                Name <span className="text-destructive">*</span>
              </label>
              <Input id="name" placeholder="Website redesign" {...form.register("name")} />
              {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="description">
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Textarea id="description" placeholder="What is this project about?" {...form.register("description")} />
              {errors.description ? <p className="text-sm text-destructive">{errors.description.message}</p> : null}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Project Type <span className="text-destructive">*</span>
                </label>
                <Controller
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{field.value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_TYPES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.type ? <p className="text-sm text-destructive">{errors.type.message}</p> : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="client">
                  Client <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="client" placeholder="Acme Corp" disabled={isInternal} {...form.register("client")} className="disabled:opacity-50" />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" className="size-3.5" {...form.register("isInternal")} />
                  This is internal work — not for a client
                </label>
                {errors.client ? <p className="text-sm text-destructive">{errors.client.message}</p> : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Priority <span className="text-destructive">*</span>
                </label>
                <Controller
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{field.value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_PRIORITIES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Visibility <span className="text-destructive">*</span>
                </label>
                <Controller
                  control={form.control}
                  name="visibility"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{field.value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_VISIBILITIES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="startDate">
                  Start date <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="startDate" type="date" {...form.register("startDate")} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="dueDate">
                  Due date <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="dueDate" type="date" {...form.register("dueDate")} />
                {errors.dueDate ? <p className="text-sm text-destructive">{errors.dueDate.message}</p> : null}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="budget">
                Budget <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input id="budget" type="number" min="0" step="0.01" placeholder="5000" {...form.register("budget")} />
              {errors.budget ? <p className="text-sm text-destructive">{errors.budget.message}</p> : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="resourceLink">
                {resourceLinkMeta.label} <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input id="resourceLink" placeholder={resourceLinkMeta.placeholder} {...form.register("resourceLink")} />
              {errors.resourceLink ? <p className="text-sm text-destructive">{errors.resourceLink.message}</p> : null}
            </div>

            {errorMessage ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.push("/dashboard/projects")}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Creating..." : "Create Project"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
