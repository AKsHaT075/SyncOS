"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CONDITIONS } from "@/features/assets/constants/assetOptions";
import { useAssetAction } from "@/features/assets/hooks/assetHooks";
import { Field, NativeSelect, SubmitButton } from "@/features/assets/components/shared";

/**
 * What each lifecycle action asks for. `field` is the name the API expects for the free-text note;
 * `condition` adds a condition picker (return / found).
 */
export const ACTIONS = {
  return: { title: "Record return", confirm: "Record return", description: "The asset goes back to available stock and the holder's assignment is closed.", field: "notes", condition: true },
  "request-return": { title: "Request return", confirm: "Send request", description: "The holder is notified and asked to hand the equipment back.", field: "note" },
  reserve: { title: "Reserve asset", confirm: "Reserve", description: "Hold this asset for an upcoming need. It can still be assigned.", field: "note" },
  release: { title: "Release reservation", confirm: "Release", description: "Put the asset back into general available stock.", field: "note" },
  retire: { title: "Retire asset", confirm: "Retire", description: "Retired assets can't be assigned. They can later be marked as disposed.", field: "note", destructive: true },
  dispose: { title: "Mark as disposed", confirm: "Mark disposed", description: "This is final. A disposed asset becomes read-only; its history is kept.", field: "note", destructive: true },
  lost: { title: "Mark as lost", confirm: "Mark lost", description: "If someone holds it, their assignment is closed as lost.", field: "note", destructive: true },
  found: { title: "Mark as found", confirm: "Mark found", description: "The asset returns to available stock.", field: "note", condition: true },
};

export default function ActionDialog({ open, onOpenChange, asset, action, extra = {} }) {
  const config = ACTIONS[action];
  const { register, handleSubmit, reset } = useForm({ defaultValues: { text: "", condition: "" } });
  const mutation = useAssetAction();

  useEffect(() => {
    if (open) reset({ text: "", condition: "" });
  }, [open, reset]);

  if (!config) return null;

  const submit = async (values) => {
    const payload = { ...extra };
    if (values.text.trim()) payload[config.field] = values.text.trim();
    if (config.condition && values.condition) payload.condition = values.condition;
    try {
      await mutation.mutateAsync({ id: asset.id, action, payload });
      onOpenChange(false);
    } catch {
      /* toast shown by the mutation */
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{asset ? `${asset.name} · ${asset.assetId}. ` : ""}{config.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          {config.condition ? (
            <Field label="Condition" htmlFor="ad-condition">
              <NativeSelect id="ad-condition" {...register("condition")}>
                <option value="">Unchanged</option>
                {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Note (optional)" htmlFor="ad-note"><Textarea id="ad-note" rows={3} maxLength={config.field === "notes" ? 1000 : 500} {...register("text")} /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Cancel</Button>
            <SubmitButton pending={mutation.isPending} variant={config.destructive ? "destructive" : "default"}>{config.confirm}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
