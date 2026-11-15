"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganizationUsage } from "@/features/account/hooks/accountHooks";

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

function Meter({ label, used, limit, detail }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      {limit ? (
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-label={label}>
          <div className={`h-full rounded-full ${ratio >= 1 ? "bg-destructive" : ratio >= 0.85 ? "bg-amber-500" : "bg-violet-500"}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Seats and storage against the plan limits. Visible to organization admins. */
export default function UsageCard() {
  const { data, isLoading, isError } = useOrganizationUsage();
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Plan and usage</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Limits stop new members and uploads once reached. Nothing existing is removed. Contact your platform administrator to change them.
      </p>
      {isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Usage could not be loaded.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Plan: <span className="font-medium capitalize text-foreground">{data.plan}</span></p>
          <Meter
            label="Seats"
            used={data.seats.used + data.seats.pendingInvitations}
            limit={data.seats.limit}
            detail={`${data.seats.used} members${data.seats.pendingInvitations ? ` + ${data.seats.pendingInvitations} pending` : ""}${data.seats.limit ? ` of ${data.seats.limit}` : " (no limit)"}`}
          />
          <Meter
            label="Storage"
            used={data.storage.usedBytes}
            limit={data.storage.limitBytes}
            detail={`${formatBytes(data.storage.usedBytes)}${data.storage.limitBytes ? ` of ${formatBytes(data.storage.limitBytes)}` : " (no limit)"}`}
          />
        </div>
      )}
    </Card>
  );
}
