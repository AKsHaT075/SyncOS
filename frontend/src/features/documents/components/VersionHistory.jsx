"use client";

import { useRef, useState } from "react";
import { Download, History, Loader2, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import ConfirmDialog from "@/features/documents/components/ConfirmDialog";
import {
  useDocumentVersions,
  useRestoreVersion,
  useUploadVersion,
} from "@/features/documents/hooks/documentHooks";
import { validateFileClientSide } from "@/features/documents/schemas/documentSchemas";
import { downloadDocument } from "@/features/documents/utils/files";
import { formatDate, formatSize } from "@/features/documents/utils/format";

export default function VersionHistory({ document: doc }) {
  const inputRef = useRef(null);
  const [changeNote, setChangeNote] = useState("");
  const [progress, setProgress] = useState(null);
  const [confirmVersion, setConfirmVersion] = useState(null);

  const { data, isLoading, isError } = useDocumentVersions(doc.id);
  const uploadVersion = useUploadVersion();
  const restoreVersion = useRestoreVersion();

  const onFileChosen = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = validateFileClientSide(file, { requireExtension: doc.extension });
    if (problem) {
      toast.error(problem);
      return;
    }
    setProgress(0);
    try {
      await uploadVersion.mutateAsync({ id: doc.id, file, changeNote: changeNote.trim(), onProgress: setProgress });
      setChangeNote("");
    } catch {
      /* toast already shown */
    } finally {
      setProgress(null);
    }
  };

  const confirmRestore = async () => {
    try {
      await restoreVersion.mutateAsync({ id: doc.id, version: confirmVersion });
      setConfirmVersion(null);
    } catch {
      /* toast already shown */
    }
  };

  return (
    <div className="space-y-4">
      {doc.access?.canEdit ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <label htmlFor="change-note" className="text-xs font-medium text-foreground">
            Upload a new version <span className="font-normal text-muted-foreground">(.{doc.extension} only)</span>
          </label>
          <Input
            id="change-note"
            value={changeNote}
            maxLength={500}
            onChange={(event) => setChangeNote(event.target.value)}
            placeholder="What changed? (optional)"
          />
          <input ref={inputRef} type="file" accept={`.${doc.extension}`} className="sr-only" aria-label="Choose replacement file" onChange={onFileChosen} />
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={uploadVersion.isPending}>
            {uploadVersion.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {uploadVersion.isPending ? `Uploading… ${progress ?? 0}%` : "Choose file"}
          </Button>
        </div>
      ) : null}

      {isError ? (
        <p role="alert" className="text-sm text-destructive">Couldn’t load the version history.</p>
      ) : isLoading || !data ? (
        <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : data.versions.length === 0 ? (
        <EmptyStateCard icon={History} title="No versions yet" />
      ) : (
        <ol className="space-y-2" aria-label="Versions">
          {data.versions.map((version) => (
            <li key={version.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    Version {version.version}
                    {version.isCurrent ? <Badge variant="secondary">Current</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {version.uploadedBy.fullName || "Unknown"} · {formatDate(version.createdAt, true)} · {formatSize(version.size)}
                  </p>
                  {version.changeNote ? <p className="mt-1 text-xs text-foreground/80">{version.changeNote}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`Download version ${version.version}`} onClick={() => downloadDocument(doc, { version: version.version })}>
                    <Download className="size-4" />
                  </Button>
                  {!version.isCurrent && doc.access?.canEdit ? (
                    <Button variant="ghost" size="icon-sm" aria-label={`Restore version ${version.version}`} onClick={() => setConfirmVersion(version.version)}>
                      <RotateCcw className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <ConfirmDialog
        open={confirmVersion !== null}
        onOpenChange={(next) => !next && setConfirmVersion(null)}
        title={`Restore version ${confirmVersion}?`}
        description="It becomes a new version at the top of the history. Nothing is overwritten or lost."
        confirmLabel="Restore"
        isPending={restoreVersion.isPending}
        onConfirm={confirmRestore}
      />
    </div>
  );
}
