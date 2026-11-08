"use client";

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
import { createTeamSchema } from "@/features/teams/schemas/teamSchemas";
import { useCreateTeam } from "@/features/teams/hooks/teamHooks";
import { usePeople } from "@/features/people/hooks/usePeople";
import { ROLES } from "@/constants/roles";
import { Loader2 } from "lucide-react";

export default function NewTeamModal({ isOpen, onClose }) {
  const mutation = useCreateTeam();
  const { data: peopleData, isLoading: isPeopleLoading } = usePeople({ limit: 100, role: ROLES.MANAGER });

  const activePeople = (peopleData?.people ?? []).filter((p) => p.isActive);

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
      lead: "",
    },
    resolver: zodResolver(createTeamSchema),
  });

  const onSubmit = async (values) => {
    const payload = {
      name: values.name,
      description: values.description || "",
      lead: values.lead === "" ? null : values.lead,
    };

    try {
      await mutation.mutateAsync(payload);
      form.reset();
      onClose();
    } catch (e) {
      // error handled by mutation
    }
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const { errors } = form.formState;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] sm:max-w-xl border-border shadow-2xl p-6">
        <DialogHeader className="mb-4">
          <DialogTitle className="text-xl font-bold">Create New Team</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Create a team to organize projects, tasks, and align colleagues.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Team Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">
              Team Name <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="e.g. Frontend Engineering"
              {...form.register("name")}
            />
            {errors.name && <p className="text-xs text-destructive font-medium">{errors.name.message}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              placeholder="What does this team focus on?"
              {...form.register("description")}
              className="min-h-[80px]"
            />
            {errors.description && <p className="text-xs text-destructive font-medium">{errors.description.message}</p>}
          </div>

          {/* Manager / Lead */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">
              Team Manager <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            {isPeopleLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-brand" /> Loading candidate managers...
              </div>
            ) : (
              <Controller
                control={form.control}
                name="lead"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a manager" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">None / Assign Later</SelectItem>
                      {activePeople.map((person) => (
                        <SelectItem key={person.id} value={person.id}>
                          {person.fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
            {errors.lead && <p className="text-xs text-destructive font-medium">{errors.lead.message}</p>}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-border mt-6">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending}
              className="bg-brand hover:bg-brand/90 font-semibold"
            >
              {mutation.isPending && <Loader2 className="size-4 animate-spin mr-2" />}
              Create Team
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
