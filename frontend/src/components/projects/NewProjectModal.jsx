"use client";

import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export default function NewProjectModal({ isOpen, onClose }) {
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
      form.reset();
      onClose();
      router.push(`/dashboard/projects/${result.project.id}`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;
  const { errors } = form.formState;
  const selectedType = form.watch("type");
  const isInternal = form.watch("isInternal");
  const resourceLinkMeta = PROJECT_TYPE_RESOURCE_LINK[selectedType] || PROJECT_TYPE_RESOURCE_LINK.Other;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] sm:max-w-3xl max-h-[90vh] overflow-y-auto gap-0 p-0 border-border/50 shadow-2xl">
        <DialogHeader className="space-y-1.5 px-6 sm:px-8 pt-7 pb-5 border-b border-border/40">
          <DialogTitle className="text-xl font-semibold tracking-tight">Create New Project</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Set up the basics — you can change all of this later.
          </DialogDescription>
        </DialogHeader>

        <form className="px-6 sm:px-8 py-6 space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
          {/* Project Name - Full Width */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="name">
              Project Name <span className="text-destructive">*</span>
            </label>
            <Input
              id="name"
              placeholder="e.g. Website redesign"
              {...form.register("name")}
              className="h-10 text-sm"
            />
            {errors.name ? <p className="text-xs text-destructive font-medium">{errors.name.message}</p> : null}
          </div>

          {/* Description - Full Width */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="description">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              id="description"
              placeholder="What is this project about?"
              {...form.register("description")}
              className="min-h-24 text-sm resize-none"
            />
            {errors.description ? <p className="text-xs text-destructive font-medium">{errors.description.message}</p> : null}
          </div>

          {/* Metadata - 2x2 Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-6">
            {/* Type */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Project Type <span className="text-destructive">*</span>
              </label>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="h-10 w-full text-sm">
                      <SelectValue>{field.value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PROJECT_TYPES.map((value) => (
                        <SelectItem key={value} value={value} className="text-sm">
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.type ? <p className="text-xs text-destructive font-medium">{errors.type.message}</p> : null}
            </div>

            {/* Priority */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Priority <span className="text-destructive">*</span>
              </label>
              <Controller
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="h-10 w-full text-sm">
                      <SelectValue>{field.value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PROJECT_PRIORITIES.map((value) => (
                        <SelectItem key={value} value={value} className="text-sm">
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Visibility */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Visibility <span className="text-destructive">*</span>
              </label>
              <Controller
                control={form.control}
                name="visibility"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="h-10 w-full text-sm">
                      <SelectValue>{field.value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PROJECT_VISIBILITIES.map((value) => (
                        <SelectItem key={value} value={value} className="text-sm">
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Start Date */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="startDate">
                Start Date <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="startDate"
                type="date"
                {...form.register("startDate")}
                className="h-10 text-sm"
              />
            </div>

            {/* Due Date */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="dueDate">
                Due Date <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="dueDate"
                type="date"
                {...form.register("dueDate")}
                className="h-10 text-sm"
              />
              {errors.dueDate ? <p className="text-xs text-destructive font-medium">{errors.dueDate.message}</p> : null}
            </div>

            {/* Client */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="client">
                Client <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="client"
                placeholder="e.g. Acme Corp"
                disabled={isInternal}
                {...form.register("client")}
                className="h-10 text-sm disabled:opacity-50"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="size-3.5" {...form.register("isInternal")} />
                This is internal work — not for a client
              </label>
              {errors.client ? <p className="text-xs text-destructive font-medium">{errors.client.message}</p> : null}
            </div>

            {/* Budget */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="budget">
                Budget <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="budget"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 5000"
                {...form.register("budget")}
                className="h-10 text-sm"
              />
              {errors.budget ? <p className="text-xs text-destructive font-medium">{errors.budget.message}</p> : null}
            </div>

            {/* Resource Link - label/placeholder depend on Project Type */}
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium text-foreground" htmlFor="resourceLink">
                {resourceLinkMeta.label} <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="resourceLink"
                placeholder={resourceLinkMeta.placeholder}
                {...form.register("resourceLink")}
                className="h-10 text-sm"
              />
              {errors.resourceLink ? (
                <p className="text-xs text-destructive font-medium">{errors.resourceLink.message}</p>
              ) : null}
            </div>
          </div>

          {/* Error Message */}
          {errorMessage ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive font-medium">
              {errorMessage}
            </div>
          ) : null}

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 -mx-6 sm:-mx-8 -mb-6 px-6 sm:px-8 py-5 border-t border-border/40 bg-muted/30">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="h-10 px-6 text-sm font-medium"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending}
              className="h-10 px-6 bg-brand hover:bg-brand/90 font-semibold text-sm"
            >
              {mutation.isPending ? "Creating..." : "Create Project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
