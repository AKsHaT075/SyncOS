"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAiSettings, useUpdateAiSettings } from "@/features/ai/hooks/aiHooks";

const MIN_QUOTA = 1000;
const MAX_QUOTA = 1_000_000_000;
const number = (value) => new Intl.NumberFormat().format(value);

function DisclosureDialog({ open, onOpenChange, disclosure, title, confirmLabel, pending, onConfirm }) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (!open) setAccepted(false); }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{disclosure?.title || title}</DialogTitle>
          <DialogDescription>Provider: {disclosure?.provider}. Read this before continuing.</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-foreground">
          {(disclosure?.points ?? []).map((point) => <li key={point}>{point}</li>)}
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I have read this and accept it on behalf of the organization.</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={() => onConfirm(disclosure.version)} disabled={!accepted || pending}>{pending ? "Saving…" : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuotaForm({ settings }) {
  const mutation = useUpdateAiSettings();
  const defaults = settings.quotaDefaults;
  const [daily, setDaily] = useState(String(settings.quotas.userDailyTokens));
  const [monthly, setMonthly] = useState(String(settings.quotas.orgMonthlyTokens));
  useEffect(() => {
    setDaily(String(settings.quotas.userDailyTokens));
    setMonthly(String(settings.quotas.orgMonthlyTokens));
  }, [settings.quotas.userDailyTokens, settings.quotas.orgMonthlyTokens]);

  const valid = (value) => /^\d+$/.test(value) && Number(value) >= MIN_QUOTA && Number(value) <= MAX_QUOTA;
  const dirty = Number(daily) !== settings.quotas.userDailyTokens || Number(monthly) !== settings.quotas.orgMonthlyTokens;
  const save = () => mutation.mutate({ quotas: { userDailyTokens: Number(daily) === defaults.userDailyTokens ? null : Number(daily), orgMonthlyTokens: Number(monthly) === defaults.orgMonthlyTokens ? null : Number(monthly) } });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Usage limits</h2>
      <p className="mb-4 text-xs text-muted-foreground">Tokens are input plus output. Defaults are {number(defaults.userDailyTokens)} per person per day and {number(defaults.orgMonthlyTokens)} per month for the organization. Your plan may cap the monthly figure further.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="ai-daily" className="text-sm font-medium">Per person, per day</label>
          <Input id="ai-daily" inputMode="numeric" value={daily} onChange={(event) => setDaily(event.target.value)} aria-invalid={!valid(daily)} />
          {!valid(daily) ? <p role="alert" className="text-xs text-destructive">Enter a whole number from {number(MIN_QUOTA)} to {number(MAX_QUOTA)}.</p> : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ai-monthly" className="text-sm font-medium">Organization, per month</label>
          <Input id="ai-monthly" inputMode="numeric" value={monthly} onChange={(event) => setMonthly(event.target.value)} aria-invalid={!valid(monthly)} />
          {!valid(monthly) ? <p role="alert" className="text-xs text-destructive">Enter a whole number from {number(MIN_QUOTA)} to {number(MAX_QUOTA)}.</p> : null}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" disabled={mutation.isPending} onClick={() => { setDaily(String(defaults.userDailyTokens)); setMonthly(String(defaults.orgMonthlyTokens)); }}>Reset to defaults</Button>
        <Button disabled={!dirty || !valid(daily) || !valid(monthly) || mutation.isPending} onClick={save}>{mutation.isPending ? "Saving…" : "Save limits"}</Button>
      </div>
    </Card>
  );
}

export default function AiSettingsPanel() {
  const { data, isLoading, isError, refetch } = useAiSettings();
  const mutation = useUpdateAiSettings();
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data) {
    return (
      <Card className="flex-row items-center justify-between gap-3 p-5">
        <p className="text-sm text-muted-foreground">AI settings could not be loaded.</p>
        <Button variant="outline" onClick={() => refetch()}>Try again</Button>
      </Card>
    );
  }

  const { settings, platform, disclosure } = data;
  const platformReady = platform.globalEnabled && platform.configured;
  const reaccept = settings.disclosure.needsReacceptance;

  return (
    <div className="space-y-5">
      {!platformReady ? (
        <Card className="flex-row items-start gap-3 border-amber-300 bg-amber-50 p-4 text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm">{!platform.globalEnabled ? "AI is switched off for this platform." : "The AI service is not configured on this server."} You can still review these settings, but AI cannot be used until that changes.</p>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">AI for your organization</h2>
              <Badge variant={settings.enabled ? "default" : "secondary"}>{settings.enabled ? "On" : "Off"}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {settings.enabled
                ? `Enabled${settings.enabledAt ? ` on ${new Date(settings.enabledAt).toLocaleDateString()}` : ""}. Members with AI access can use AI Studio. Guests never can.`
                : "AI is off by default. Turning it on requires accepting the data disclosure."}
            </p>
          </div>
          {settings.enabled ? (
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setDisableOpen(true)}>Turn off</Button>
          ) : (
            <Button disabled={!platformReady || mutation.isPending} onClick={() => setEnableOpen(true)}>Review disclosure and turn on</Button>
          )}
        </div>
        {reaccept ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 p-3 text-amber-900">
            <p className="text-sm">The disclosure has been updated. Please review and accept the new version.</p>
            <Button size="sm" onClick={() => setEnableOpen(true)}>Review</Button>
          </div>
        ) : null}
        {settings.disclosure.acceptedAt ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4" /> Disclosure {settings.disclosure.acceptedVersion} accepted on {new Date(settings.disclosure.acceptedAt).toLocaleDateString()}.</p>
        ) : null}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Live organization data</h2>
          <Badge variant="secondary">Not available yet</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Letting the assistant look up tasks, projects and schedules is a separate, later step with its own disclosure. It is not offered from this screen yet, and it stays off on this server.
        </p>
      </Card>

      <QuotaForm settings={settings} />

      <DisclosureDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        disclosure={disclosure}
        title="Enable AI features"
        confirmLabel={settings.enabled ? "Accept" : "Accept and turn on"}
        pending={mutation.isPending}
        onConfirm={(version) => mutation.mutate({ enabled: true, acceptDisclosureVersion: version }, { onSuccess: () => setEnableOpen(false) })}
      />
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn AI off?</DialogTitle>
            <DialogDescription>All AI requests stop immediately for everyone in the organization. Conversations are kept.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate({ enabled: false }, { onSuccess: () => setDisableOpen(false) })}>Turn off</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
