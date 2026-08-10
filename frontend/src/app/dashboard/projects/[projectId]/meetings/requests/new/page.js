"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createMeetingRequestSchema } from "@/features/meetingRequests/schemas/meetingRequestSchemas";
import { useCreateMeetingRequest } from "@/features/meetingRequests/hooks/useCreateMeetingRequest";
import { useProject } from "@/features/projects/hooks/useProject";
import { getFriendlyErrorMessage } from "@/lib/error-message";
import { getProjectPeople } from "@/features/tasks/utils/projectPeople";

const DEFAULT_VALUES = {
  topic: "",
  reason: "",
  requestedMembers: [],
  preferredDate: "",
  preferredTime: "",
};

export default function NewMeetingRequestPage() {
  const { projectId } = useParams();
  const router = useRouter();
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;
  const people = getProjectPeople(project);

  const mutation = useCreateMeetingRequest(projectId);
  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    resolver: zodResolver(createMeetingRequestSchema),
    mode: "onTouched",
  });

  const selectedMembers = form.watch("requestedMembers") || [];
  const toggleMember = (personId) => {
    const next = selectedMembers.includes(personId)
      ? selectedMembers.filter((id) => id !== personId)
      : [...selectedMembers, personId];
    form.setValue("requestedMembers", next, { shouldDirty: true });
  };

  const onSubmit = async (values) => {
    mutation.reset();

    const payload = {
      topic: values.topic,
      reason: values.reason,
      requestedMembers: values.requestedMembers?.length ? values.requestedMembers : undefined,
      preferredDate: values.preferredDate ? new Date(values.preferredDate).toISOString() : undefined,
      preferredTime: values.preferredTime || undefined,
    };

    try {
      await mutation.mutateAsync(payload);
      router.push(`/dashboard/projects/${projectId}/meetings`);
    } catch (error) {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;
  const { errors } = form.formState;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Link
        href={`/dashboard/projects/${projectId}/meetings`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back to meetings
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Request a meeting</CardTitle>
          <CardDescription>A project manager will approve, reject, or schedule this request.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="topic">
                Topic <span className="text-destructive">*</span>
              </label>
              <Input id="topic" placeholder="e.g. Design review" {...form.register("topic")} />
              {errors.topic ? <p className="text-sm text-destructive">{errors.topic.message}</p> : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="reason">
                Reason <span className="text-destructive">*</span>
              </label>
              <Textarea id="reason" placeholder="Why is this meeting needed?" {...form.register("reason")} />
              {errors.reason ? <p className="text-sm text-destructive">{errors.reason.message}</p> : null}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="preferredDate">
                  Preferred date <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="preferredDate" type="date" {...form.register("preferredDate")} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="preferredTime">
                  Preferred time <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input id="preferredTime" type="time" {...form.register("preferredTime")} />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Requested members <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {people.length === 0 ? (
                  <p className="p-1 text-xs text-muted-foreground">No eligible members.</p>
                ) : (
                  people.map((person) => (
                    <label key={person.id} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        className="size-3.5"
                        checked={selectedMembers.includes(person.id)}
                        onChange={() => toggleMember(person.id)}
                      />
                      {person.fullName} <span className="text-xs text-muted-foreground">({person.role})</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            {errorMessage ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage}</p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => router.push(`/dashboard/projects/${projectId}/meetings`)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Sending..." : "Send Request"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
