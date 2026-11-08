"use client";

import { Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useDocumentActivity } from "@/features/documents/hooks/documentHooks";
import { ACTION_LABELS } from "@/features/documents/constants/documentOptions";
import { formatDate } from "@/features/documents/utils/format";

function detail(entry) {
  const { action, metadata = {} } = entry;
  if (action === "document.renamed" && metadata.from) return `“${metadata.from}” → “${metadata.to}”`;
  if (action === "document.version_uploaded" || action === "document.version_restored") return `Version ${metadata.version}`;
  if (action === "document.visibility_changed") return `${metadata.from} → ${metadata.to}`;
  if (action === "document.shared") return metadata.permission ? `as ${metadata.permission}` : null;
  return null;
}

export default function ActivityList({ documentId }) {
  const { data, isLoading, isError } = useDocumentActivity(documentId);

  if (isError) {
    return <p role="alert" className="text-sm text-destructive">Couldn’t load the activity.</p>;
  }
  if (isLoading || !data) {
    return <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>;
  }
  if (data.activity.length === 0) {
    return <EmptyStateCard icon={Activity} title="No activity yet" />;
  }

  return (
    <ol className="space-y-3" aria-label="Activity">
      {data.activity.map((entry) => (
        <li key={entry.id} className="flex gap-3 text-sm">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-foreground">
              <span className="font-medium">{entry.user?.fullName ?? "Someone"}</span>{" "}
              {ACTION_LABELS[entry.action] ?? entry.action}
              {detail(entry) ? <span className="text-muted-foreground"> · {detail(entry)}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">{formatDate(entry.createdAt, true)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
