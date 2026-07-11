"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createTaskSchema } from "@/features/tasks/schemas/taskSchemas";
import { useCreateTask } from "@/features/tasks/hooks/useCreateTask";
import { useProject } from "@/features/projects/hooks/useProject";
import { getFriendlyErrorMessage } from "@/lib/error-message";
import { TASK_PRIORITIES, TASK_VISIBILITIES } from "@/features/tasks/constants/taskOptions";
import { getProjectPeople } from "@/features/tasks/utils/projectPeople";

const DEFAULT_VALUES = {
  title: "",
  description: "",
  priority: "Medium",
  visibility: "Public",
  startDate: "",
  dueDate: "",
  estimatedHours: "",
  owner: "",
  assignees: [],
  approvers: [],
};

export default function NewTaskPage() {
  const { projectId } = useParams();
  const router = useRouter();
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;
  const people = getProjectPeople(project);

  const mutation = useCreateTask(projectId);
  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    resolver: zodResolver(createTaskSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();

    const payload = {
      ...values,
      description: values.description || undefined,
      owner: values.owner || undefined,
      startDate: values.startDate || undefined,
      dueDate: values.dueDate || undefined,
      estimatedHours: values.estimatedHours !== "" ? Number(values.estimatedHours) : undefined,
      assignees: values.assignees?.length ? values.assignees : undefined,
      approvers: values.approvers?.length ? values.approvers : undefined,
    };

    try {
      const result = await mutation.mutateAsync(payload);
      router.push(`/dashboard/projects/${projectId}/tasks/${result.task.id}`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;
  const { errors } = form.formState;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Link
        href={`/dashboard/projects/${projectId}/tasks`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back to tasks
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">New task</CardTitle>
          <CardDescription>Tasks stay scoped to this project — assignees and approvers must be project members.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="title">
                Title <span className="text-destructive">*</span>
              </label>
              <Input id="title" placeholder="e.g. Set up CI pipeline" {...form.register("title")} />
              {errors.title ? <p className="text-sm text-destructive">{errors.title.message}</p> : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="description">
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Textarea id="description" placeholder="What needs to be done?" {...form.register("description")} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Priority</label>
                <Controller
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{field.value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_PRIORITIES.map((value) => (
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
                <label className="text-sm font-medium">Visibility</label>
                <Controller
                  control={form.control}
                  name="visibility"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{field.value}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_VISIBILITIES.map((value) => (
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
              <label className="text-sm font-medium" htmlFor="estimatedHours">
                Estimated hours <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input id="estimatedHours" type="number" min="0" step="0.5" placeholder="e.g. 8" {...form.register("estimatedHours")} />
              {errors.estimatedHours ? <p className="text-sm text-destructive">{errors.estimatedHours.message}</p> : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Owner <span className="text-muted-foreground font-normal">(defaults to you)</span>
              </label>
              <Controller
                control={form.control}
                name="owner"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="You" />
                    </SelectTrigger>
                    <SelectContent>
                      {people.map((person) => (
                        <SelectItem key={person.id} value={person.id}>
                          {person.fullName} ({person.role})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <PeopleCheckboxField label="Assignees" name="assignees" people={people} form={form} />
            <PeopleCheckboxField
              label="Approvers"
              name="approvers"
              people={people}
              form={form}
              hint="Project Owners/Managers can always approve, even if not listed here — pick anyone else you want to explicitly loop in as a reviewer."
            />

            {errorMessage ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.push(`/dashboard/projects/${projectId}/tasks`)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Creating..." : "Create Task"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function PeopleCheckboxField({ label, name, people, form, hint }) {
  const selected = form.watch(name) || [];

  const toggle = (personId) => {
    const next = selected.includes(personId) ? selected.filter((id) => id !== personId) : [...selected, personId];
    form.setValue(name, next, { shouldDirty: true });
  };

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label} <span className="text-muted-foreground font-normal">(optional)</span></label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
        {people.length === 0 ? (
          <p className="p-1 text-xs text-muted-foreground">No eligible members.</p>
        ) : (
          people.map((person) => (
            <label key={person.id} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-accent">
              <input
                type="checkbox"
                className="size-3.5"
                checked={selected.includes(person.id)}
                onChange={() => toggle(person.id)}
              />
              {person.fullName} <span className="text-xs text-muted-foreground">({person.role})</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
