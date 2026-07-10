"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { updateProjectSchema } from "@/features/projects/schemas/projectSchemas";
import { useProject } from "@/features/projects/hooks/useProject";
import { useUpdateProject } from "@/features/projects/hooks/useUpdateProject";
import { useArchiveProject, useRestoreProject } from "@/features/projects/hooks/useArchiveProject";
import { useDeleteProject } from "@/features/projects/hooks/useDeleteProject";
import { useTransferOwnership } from "@/features/projects/hooks/useTransferOwnership";
import { useProjectMemberCandidates } from "@/features/projects/hooks/useProjectMemberCandidates";
import {
  PROJECT_VISIBILITIES,
  PROJECT_PRIORITIES,
  PROJECT_TYPES,
  PROJECT_TYPE_RESOURCE_LINK,
} from "@/features/projects/constants/projectOptions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const ALLOWED_OWNER_ROLES = ["org-admin", "admin", "manager", "hr"];

function dateInputValue(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function SettingsSection({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="mb-3 text-base font-semibold text-zinc-900">{title}</h2>
      <div className="space-y-5 rounded-md border border-zinc-200 bg-white p-5">{children}</div>
    </section>
  );
}

function DangerRow({ title, description, children }) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function TransferOwnershipPopover({ projectId, project }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const { data, isFetching } = useProjectMemberCandidates(projectId, debouncedSearch, open);
  const transferMutation = useTransferOwnership(projectId);
  const candidates = (data?.candidates || []).filter((c) => ALLOWED_OWNER_ROLES.includes(c.role));

  const handleTransfer = (userId) => {
    transferMutation.mutate(
      { newOwnerId: userId },
      {
        onSuccess: () => {
          setOpen(false);
          setSearch("");
        },
      }
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Users className="mr-1.5 size-4" />
          Transfer
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">New owner (admins & managers only)</p>
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
          />
        </div>
        <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
          {isFetching ? (
            <p className="p-2 text-xs text-muted-foreground">Searching...</p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No eligible users found.</p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => handleTransfer(candidate.id)}
                disabled={transferMutation.isPending}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent"
              >
                <Avatar size="sm">
                  <AvatarFallback>{initials(candidate.fullName)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{candidate.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{candidate.email}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeleteProjectButton({ projectId }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const router = useRouter();
  const deleteMutation = useDeleteProject(projectId);

  const handleDelete = () => {
    deleteMutation.mutate(projectId, {
      onSuccess: () => {
        router.push("/dashboard/projects");
      },
    });
  };

  if (showConfirm) {
    return (
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setShowConfirm(false)} disabled={deleteMutation.isPending}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteMutation.isPending}>
          {deleteMutation.isPending ? "Deleting..." : "Yes, delete forever"}
        </Button>
      </div>
    );
  }

  return (
    <Button variant="destructive" size="sm" onClick={() => setShowConfirm(true)}>
      <Trash2 className="mr-1.5 size-4" />
      Delete project
    </Button>
  );
}

export default function ProjectSettingsPage() {
  const { projectId } = useParams();
  const { data, isLoading } = useProject(projectId);
  const updateMutation = useUpdateProject(projectId);
  const archiveMutation = useArchiveProject();
  const restoreMutation = useRestoreProject();
  const project = data?.project;

  const [selectedType, setSelectedType] = useState("Other");
  const [selectedPriority, setSelectedPriority] = useState("Medium");

  const detailsForm = useForm({
    defaultValues: {
      name: "",
      description: "",
      isInternal: false,
      client: "",
      budget: "",
      resourceLink: "",
      startDate: "",
      dueDate: "",
    },
    resolver: zodResolver(updateProjectSchema),
    mode: "onTouched",
  });

  useEffect(() => {
    if (project) {
      detailsForm.reset({
        name: project.name,
        description: project.description || "",
        isInternal: Boolean(project.isInternal),
        client: project.client || "",
        budget: project.budget ?? "",
        resourceLink: project.resourceLink || "",
        startDate: dateInputValue(project.startDate),
        dueDate: dateInputValue(project.dueDate),
      });
      setSelectedType(project.type || "Other");
      setSelectedPriority(project.priority || "Medium");
    }
  }, [project]);

  const isInternal = detailsForm.watch("isInternal");
  const resourceLinkMeta = PROJECT_TYPE_RESOURCE_LINK[selectedType] || PROJECT_TYPE_RESOURCE_LINK.Other;

  const onSubmitDetails = (values) => {
    updateMutation.mutate({
      ...values,
      type: selectedType,
      priority: selectedPriority,
      description: values.description || undefined,
      client: values.isInternal ? undefined : values.client || undefined,
      budget: values.budget !== "" ? Number(values.budget) : undefined,
      resourceLink: values.resourceLink || undefined,
      startDate: values.startDate || undefined,
      dueDate: values.dueDate || undefined,
    });
  };

  if (isLoading || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div className="space-y-8">
        <form className="space-y-8" onSubmit={detailsForm.handleSubmit(onSubmitDetails)}>
          <SettingsSection id="general" title="General">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="name">
                Name <span className="text-destructive">*</span>
              </label>
              <Input id="name" {...detailsForm.register("name")} />
              {detailsForm.formState.errors.name ? (
                <p className="text-sm text-destructive">{detailsForm.formState.errors.name.message}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="description">
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Textarea id="description" rows={3} {...detailsForm.register("description")} />
              {detailsForm.formState.errors.description ? (
                <p className="text-sm text-destructive">{detailsForm.formState.errors.description.message}</p>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-700">
                  Project Type <span className="text-destructive">*</span>
                </label>
                <Select value={selectedType} onValueChange={(value) => value && setSelectedType(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{selectedType}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECT_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-700">
                  Priority <span className="text-destructive">*</span>
                </label>
                <Select value={selectedPriority} onValueChange={(value) => value && setSelectedPriority(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{selectedPriority}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECT_PRIORITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="timeline" title="Timeline">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-700" htmlFor="startDate">
                  Start Date <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="startDate" type="date" {...detailsForm.register("startDate")} />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-700" htmlFor="dueDate">
                  Due Date <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="dueDate" type="date" {...detailsForm.register("dueDate")} />
                {detailsForm.formState.errors.dueDate ? (
                  <p className="text-sm text-destructive">{detailsForm.formState.errors.dueDate.message}</p>
                ) : null}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="client-budget" title="Client & Budget">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="client">
                Client <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="client"
                placeholder="e.g. Acme Corp"
                disabled={isInternal}
                {...detailsForm.register("client")}
                className="disabled:opacity-50"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="size-3.5" {...detailsForm.register("isInternal")} />
                This is internal work — not for a client
              </label>
              {detailsForm.formState.errors.client ? (
                <p className="text-sm text-destructive">{detailsForm.formState.errors.client.message}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700" htmlFor="budget">
                Budget <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input id="budget" type="number" min="0" step="0.01" placeholder="e.g. 5000" {...detailsForm.register("budget")} />
              {detailsForm.formState.errors.budget ? (
                <p className="text-sm text-destructive">{detailsForm.formState.errors.budget.message}</p>
              ) : null}
            </div>
          </SettingsSection>

          <SettingsSection id="links" title={resourceLinkMeta.label}>
            <div className="space-y-2">
              <Input id="resourceLink" placeholder={resourceLinkMeta.placeholder} {...detailsForm.register("resourceLink")} />
              {detailsForm.formState.errors.resourceLink ? (
                <p className="text-sm text-destructive">{detailsForm.formState.errors.resourceLink.message}</p>
              ) : null}
            </div>
          </SettingsSection>

          <div className="flex justify-end">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>

        <section id="danger-zone" className="scroll-mt-6">
          <h2 className="mb-3 text-base font-semibold text-red-600">Danger Zone</h2>
          <div className="divide-y divide-red-100 rounded-md border border-red-200 bg-white">
            <DangerRow title="Change project visibility" description="Who can see this project.">
              <Select value={project.visibility} onValueChange={(value) => updateMutation.mutate({ visibility: value })}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue>{project.visibility}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_VISIBILITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DangerRow>

            <DangerRow
              title={project.archived ? "Restore this project" : "Archive this project"}
              description={
                project.archived
                  ? "This project is archived. Restore it to make it active again."
                  : "Archiving hides this project from active lists. It can be restored at any time."
              }
            >
              {project.archived ? (
                <Button variant="outline" size="sm" onClick={() => restoreMutation.mutate(projectId)} disabled={restoreMutation.isPending}>
                  {restoreMutation.isPending ? "Restoring..." : "Restore project"}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => archiveMutation.mutate(projectId)} disabled={archiveMutation.isPending}>
                  {archiveMutation.isPending ? "Archiving..." : "Archive project"}
                </Button>
              )}
            </DangerRow>

            <DangerRow title="Transfer ownership" description="Transfer this project to another admin or manager in the organization.">
              <TransferOwnershipPopover projectId={projectId} project={project} />
            </DangerRow>

            <DangerRow title="Delete this project" description="Permanently remove this project and all its data. This cannot be undone.">
              <DeleteProjectButton projectId={projectId} />
            </DangerRow>
          </div>
        </section>
      </div>
    </div>
  );
}
