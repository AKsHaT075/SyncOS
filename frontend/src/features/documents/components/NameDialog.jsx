"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** One-field dialog reused for "New folder" and for renaming documents/folders. */
export default function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label = "Name",
  placeholder,
  initialValue = "",
  submitLabel = "Save",
  schema,
  isPending = false,
  onSubmit,
}) {
  const form = useForm({ defaultValues: { name: initialValue }, resolver: zodResolver(schema) });

  useEffect(() => {
    if (open) form.reset({ name: initialValue });
  }, [open, initialValue, form]);

  const submit = async (values) => {
    try {
      await onSubmit(values.name);
      onOpenChange(false);
    } catch {
      /* the mutation already surfaced the error; keep the dialog open */
    }
  };

  const error = form.formState.errors.name?.message;

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="name-dialog-input" className="text-xs font-medium text-foreground">{label}</label>
            <Input
              id="name-dialog-input"
              autoFocus
              placeholder={placeholder}
              aria-invalid={Boolean(error)}
              {...form.register("name")}
            />
            {error ? <p role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
