"use client";

import { AlertCircle, Lock, Mail, MonitorSmartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { CATEGORIES } from "@/features/notifications/constants/notificationOptions";
import { useNotificationPreferences, useUpdateNotificationPreferences } from "@/features/notifications/hooks/notificationHooks";

function Row({ icon: Icon, title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-6">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange, caption }) {
  return (
    <label className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground">
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
      <span className="hidden sm:block" aria-hidden="true">{caption}</span>
    </label>
  );
}

export default function NotificationPreferences() {
  const { data, isLoading, isError, refetch } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  if (isLoading) {
    return <div className="space-y-3" aria-busy="true"><Skeleton className="h-28 w-full rounded-xl" /><Skeleton className="h-72 w-full rounded-xl" /></div>;
  }
  if (isError || !data) {
    return (
      <Card className="py-8">
        <EmptyStateCard icon={AlertCircle} title="Couldn’t load your preferences" description="Check your connection and try again." />
        <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button></div>
      </Card>
    );
  }

  const { channels, categories } = data.preferences;

  return (
    <div className="space-y-5">
      <Card className="gap-0 divide-y divide-border rounded-xl border border-border py-0 shadow-sm ring-0">
        <div className="px-4 py-3 sm:px-5"><h2 className="text-sm font-semibold text-foreground">Delivery</h2></div>
        <Row icon={MonitorSmartphone} title="In-app notifications" description="The bell and your notification inbox.">
          <Toggle label="In-app notifications" checked={channels.inApp} onChange={(value) => update.mutate({ channels: { inApp: value } })} />
        </Row>
        <Row icon={Mail} title="Email notifications" description="Only for important events — never for minor updates.">
          <Toggle label="Email notifications" checked={channels.email} onChange={(value) => update.mutate({ channels: { email: value } })} />
        </Row>
      </Card>

      <Card className="gap-0 divide-y divide-border rounded-xl border border-border py-0 shadow-sm ring-0">
        <div className="flex items-center justify-between px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-foreground">What you’re notified about</h2>
          <div className="hidden gap-6 pr-1 text-[11px] font-medium text-muted-foreground uppercase sm:flex">
            <span className="w-9 text-center">In-app</span><span className="w-9 text-center">Email</span>
          </div>
        </div>

        {CATEGORIES.map((category) => {
          const value = categories[category.value];
          return (
            <Row key={category.value} title={category.label} description={category.description}>
              <Toggle
                label={`${category.label}: in-app`}
                caption="In-app"
                checked={value.inApp}
                disabled={!channels.inApp}
                onChange={(next) => update.mutate({ categories: { [category.value]: { inApp: next } } })}
              />
              {category.email ? (
                <Toggle
                  label={`${category.label}: email`}
                  caption="Email"
                  checked={value.email}
                  disabled={!channels.email}
                  onChange={(next) => update.mutate({ categories: { [category.value]: { email: next } } })}
                />
              ) : (
                <span className="flex w-9 flex-col items-center gap-1 text-[11px] text-muted-foreground" title="No emails are sent for this category">
                  <span className="text-lg leading-5">—</span><span className="hidden sm:block">Email</span>
                </span>
              )}
            </Row>
          );
        })}

        <Row icon={Lock} title="Security & account" description="Access changes, password resets and account notices. These can’t be turned off.">
          <Badge variant="secondary">Always on</Badge>
        </Row>
      </Card>

      {!channels.inApp || !channels.email ? (
        <p className="text-xs text-muted-foreground">
          {!channels.inApp ? "In-app notifications are off, so you won’t see new items in the bell. " : ""}
          {!channels.email ? "Email is off, so category email settings are paused." : ""}
        </p>
      ) : null}
    </div>
  );
}
