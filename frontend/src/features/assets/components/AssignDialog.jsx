"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CONDITIONS } from "@/features/assets/constants/assetOptions";
import { useAssetAction } from "@/features/assets/hooks/assetHooks";
import { assignSchema } from "@/features/assets/schemas/assetSchemas";
import { compact } from "@/features/assets/utils/format";
import { Field, NativeSelect, SubmitButton } from "@/features/assets/components/shared";
import { usePeople } from "@/features/people/hooks/usePeople";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

/**
 * Assign (mode="assign") or transfer (mode="transfer") an asset. For a software license only people can hold a seat,
 * and a transfer names whose seat moves (`fromUserId`).
 */
export default function AssignDialog({ open, onOpenChange, asset, mode = "assign", fromUserId = null }) {
  const software = asset?.kind === "software";
  const form = useForm({ resolver: zodResolver(assignSchema), defaultValues: { assigneeType: "user", userId: "", teamId: "", expectedReturnDate: "", condition: "", notes: "" } });
  const { register, handleSubmit, reset, control, setValue, formState: { errors } } = form;
  const type = useWatch({ control, name: "assigneeType" });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const debounced = useDebouncedValue(search, 250);
  const { data: people, isFetching } = usePeople({ search: debounced || undefined, limit: 20, sortBy: "name", sortOrder: "asc" });
  const { data: teams } = useTeams({ limit: 100 });
  const action = useAssetAction();

  useEffect(() => {
    if (open) {
      reset({ assigneeType: "user", userId: "", teamId: "", expectedReturnDate: "", condition: "", notes: "" });
      setSearch("");
      setSelected(null);
      setListOpen(false);
    }
  }, [open, reset]);

  const submit = async (values) => {
    const payload = {
      assigneeType: values.assigneeType,
      ...(values.assigneeType === "user" ? { userId: values.userId } : { teamId: values.teamId }),
      ...compact({ expectedReturnDate: values.expectedReturnDate, condition: values.condition, notes: values.notes }),
      ...(mode === "transfer" && software && fromUserId ? { fromUserId } : {}),
    };
    try {
      await action.mutateAsync({ id: asset.id, action: mode, payload });
      onOpenChange(false);
    } catch {
      /* toast shown by the mutation */
    }
  };

  const candidates = (people?.people ?? []).filter((person) => person.isActive && !person.orgBlocked);
  const title = mode === "transfer" ? "Transfer asset" : software ? "Assign a seat" : "Assign asset";

  return (
    <Dialog open={open} onOpenChange={(next) => !action.isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{asset ? `${asset.name} · ${asset.assetId}` : ""}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
          {!software ? (
            <Field label="Assign to" htmlFor="as-type">
              <NativeSelect id="as-type" {...register("assigneeType")}>
                <option value="user">A person</option>
                <option value="team">A team (shared equipment)</option>
              </NativeSelect>
            </Field>
          ) : null}

          {type === "user" ? (
            <Field label="Person *" htmlFor="as-search" error={errors.userId?.message}>
              <div className="relative">
                <Input
                  id="as-search"
                  role="combobox"
                  aria-expanded={listOpen}
                  aria-controls="as-people"
                  autoComplete="off"
                  placeholder="Search by name or email"
                  value={selected ? selected.fullName : search}
                  onFocus={() => setListOpen(true)}
                  onChange={(event) => {
                    setSelected(null);
                    setValue("userId", "", { shouldValidate: false });
                    setSearch(event.target.value);
                    setListOpen(true);
                  }}
                />
                {listOpen && !selected ? (
                  <ul id="as-people" role="listbox" className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md">
                    {candidates.length === 0 ? (
                      <li className="px-3 py-2 text-muted-foreground">{isFetching ? "Searching…" : "No matching people"}</li>
                    ) : candidates.map((person) => (
                      <li key={person.id} role="option" aria-selected={false}>
                        <button
                          type="button"
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
                          onClick={() => { setSelected(person); setValue("userId", person.id, { shouldValidate: true }); setListOpen(false); }}
                        >
                          <span className="block font-medium">{person.fullName}</span>
                          {person.email ? <span className="block text-xs text-muted-foreground">{person.email}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <input type="hidden" {...register("userId")} />
            </Field>
          ) : (
            <Field label="Team *" htmlFor="as-team" error={errors.teamId?.message}>
              <NativeSelect id="as-team" {...register("teamId")}>
                <option value="">Select a team</option>
                {(teams?.teams ?? []).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </NativeSelect>
            </Field>
          )}

          {!software ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Expected return (optional)" htmlFor="as-return" error={errors.expectedReturnDate?.message}><Input id="as-return" type="date" {...register("expectedReturnDate")} /></Field>
              <Field label="Condition now (optional)" htmlFor="as-condition">
                <NativeSelect id="as-condition" {...register("condition")}>
                  <option value="">Unchanged</option>
                  {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </NativeSelect>
              </Field>
            </div>
          ) : null}
          <Field label="Notes" htmlFor="as-notes" error={errors.notes?.message}><Textarea id="as-notes" rows={2} placeholder="Optional — kept in the history" {...register("notes")} /></Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={action.isPending}>Cancel</Button>
            <SubmitButton pending={action.isPending}>{mode === "transfer" ? "Transfer" : "Assign"}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
