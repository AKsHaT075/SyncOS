"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { useTeams } from "@/features/teams/hooks/teamHooks";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { useUploadDocument } from "@/features/documents/hooks/documentHooks";
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_SIZE_HINT_MB,
  ORG_WIDE_PUBLISH_ROLES,
  VISIBILITY_OPTIONS,
} from "@/features/documents/constants/documentOptions";
import { uploadFormSchema, validateFileClientSide } from "@/features/documents/schemas/documentSchemas";
import { formatSize } from "@/features/documents/utils/format";

const DEFAULTS = { name: "", description: "", visibility: "private", teamId: "", projectId: "" };

export default function UploadDocumentDialog({ open, onOpenChange, folderId, folderName, initialFiles = [] }) {
  const role = useAuthStore((state) => state.role);
  const inputRef = useRef(null);
  const [entries, setEntries] = useState([]); // { file, error, status: idle|uploading|done|failed, progress }
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const uploadMutation = useUploadDocument();
  const form = useForm({ defaultValues: DEFAULTS, resolver: zodResolver(uploadFormSchema) });
  const visibility = form.watch("visibility");

  const { data: teamsData } = useTeams({ limit: 100 });
  const { data: projectsData } = useProjects({ limit: 100 });
  const teams = teamsData?.teams ?? [];
  // Non-admins can only publish to projects they belong to.
  const projects = (projectsData?.projects ?? []).filter(
    (project) => project.myRole || role === "org-admin" || role === "admin",
  );

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList ?? []).map((file) => ({
      file,
      error: validateFileClientSide(file),
      status: "idle",
      progress: 0,
    }));
    setEntries((current) => [...current, ...incoming]);
  }, []);

  useEffect(() => {
    if (open) {
      form.reset(DEFAULTS);
      setEntries([]);
      setBusy(false);
      if (initialFiles.length) addFiles(initialFiles);
    }
  }, [open]);

  const patchEntry = (index, patch) =>
    setEntries((current) => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const submit = async (values) => {
    const uploadable = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !entry.error && entry.status !== "done");
    if (uploadable.length === 0) return;
    setBusy(true);
    let failures = 0;

    // Sequential: keeps progress readable and avoids hammering the API.
    for (const { entry, index } of uploadable) {
      patchEntry(index, { status: "uploading", progress: 0 });
      try {
        await uploadMutation.mutateAsync({
          file: entry.file,
          fields: {
            name: entries.length === 1 ? values.name : "",
            description: values.description,
            visibility: values.visibility,
            teamId: values.visibility === "team" ? values.teamId : "",
            projectId: values.visibility === "project" ? values.projectId : "",
            folderId: folderId ?? "",
          },
          onProgress: (progress) => patchEntry(index, { progress }),
        });
        patchEntry(index, { status: "done", progress: 100 });
      } catch (error) {
        failures += 1;
        patchEntry(index, { status: "failed", error: error?.response?.data?.message || "Upload failed" });
      }
    }

    setBusy(false);
    if (failures === 0) onOpenChange(false);
  };

  const errors = form.formState.errors;
  const pending = entries.filter((entry) => !entry.error && entry.status !== "done").length;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] w-[95vw] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Upload documents</DialogTitle>
          <DialogDescription>
            Uploading to <span className="font-medium text-foreground">{folderName ?? "Library root"}</span>. Files are private until you choose otherwise.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <div
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30",
            )}
          >
            <UploadCloud className="size-7 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-foreground">Drag files here, or</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              className="sr-only"
              aria-label="Choose files to upload"
              onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
              Browse files
            </Button>
            <p className="text-xs text-muted-foreground">
              PDF, Word, Excel, PowerPoint, TXT, CSV, PNG, JPG, ZIP · up to {MAX_FILE_SIZE_HINT_MB} MB each
            </p>
          </div>

          {entries.length > 0 ? (
            <ul className="space-y-1.5" aria-label="Selected files">
              {entries.map((entry, index) => (
                <li key={`${entry.file.name}-${index}`} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{entry.file.name}</p>
                      <p className={cn("text-xs", entry.error ? "text-destructive" : "text-muted-foreground")}>
                        {entry.error || formatSize(entry.file.size)}
                      </p>
                    </div>
                    {entry.status === "uploading" ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Uploading" /> : null}
                    {entry.status === "done" ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Uploaded" /> : null}
                    {entry.status !== "uploading" && entry.status !== "done" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${entry.file.name}`}
                        disabled={busy}
                        onClick={() => setEntries((current) => current.filter((_, i) => i !== index))}
                      >
                        <X className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  {entry.status === "uploading" ? (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={entry.progress} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full bg-primary transition-all" style={{ width: `${entry.progress}%` }} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {entries.length === 1 ? (
            <div className="space-y-1.5">
              <label htmlFor="doc-name" className="text-xs font-medium text-foreground">
                Name <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input id="doc-name" placeholder={entries[0].file.name} {...form.register("name")} />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="doc-visibility">Who can access it</label>
            <Controller
              control={form.control}
              name="visibility"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="doc-visibility" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VISIBILITY_OPTIONS.map((option) => {
                      const blocked = option.value === "organization" && !ORG_WIDE_PUBLISH_ROLES.includes(role);
                      return (
                        <SelectItem key={option.value} value={option.value} disabled={blocked}>
                          {option.label} — {blocked ? "managers, HR and admins only" : option.description}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {visibility === "team" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="doc-team">Team</label>
              <Controller
                control={form.control}
                name="teamId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="doc-team" className="w-full" aria-invalid={Boolean(errors.teamId)}>
                      <SelectValue placeholder={teams.length ? "Choose a team" : "You aren't on a team"} />
                    </SelectTrigger>
                    <SelectContent>
                      {teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.teamId ? <p role="alert" className="text-xs font-medium text-destructive">{errors.teamId.message}</p> : null}
            </div>
          ) : null}

          {visibility === "project" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="doc-project">Project</label>
              <Controller
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="doc-project" className="w-full" aria-invalid={Boolean(errors.projectId)}>
                      <SelectValue placeholder={projects.length ? "Choose a project" : "You aren't on a project"} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.projectId ? <p role="alert" className="text-xs font-medium text-destructive">{errors.projectId.message}</p> : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="doc-description" className="text-xs font-medium text-foreground">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea id="doc-description" rows={2} maxLength={1000} {...form.register("description")} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || pending === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
              {pending > 1 ? `Upload ${pending} files` : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
