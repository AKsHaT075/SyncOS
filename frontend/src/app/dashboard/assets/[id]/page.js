"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, ArrowLeft, ArrowRightLeft, CornerDownLeft, Laptop, KeyRound, MoreHorizontal, Pencil, RotateCcw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import ActionDialog from "@/features/assets/components/ActionDialog";
import AssetFormDialog from "@/features/assets/components/AssetFormDialog";
import AssignDialog from "@/features/assets/components/AssignDialog";
import { ActivityTab, DocumentsTab, HistoryTab, MaintenanceTab, OverviewTab } from "@/features/assets/components/AssetDetailTabs";
import { ReportIssueDialog } from "@/features/assets/components/MaintenanceDialogs";
import { ErrorState, StatusBadge } from "@/features/assets/components/shared";
import { useArchiveAsset, useAsset, useRestoreAsset } from "@/features/assets/hooks/assetHooks";

export default function AssetDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, error, refetch } = useAsset(id);
  const canViewAll = usePermission(PERMISSIONS.VIEW_ASSETS);
  const archive = useArchiveAsset();
  const restore = useRestoreAsset();
  // dialog: { type: "edit" | "assign" | "transfer" | "issue" | action name, userId? }
  const [dialog, setDialog] = useState({ type: null, userId: null });
  const [tab, setTab] = useState("overview");
  const close = () => setDialog({ type: null, userId: null });

  if (isLoading) return <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6"><Skeleton className="h-10 w-72" /><Skeleton className="h-64 w-full rounded-xl" /></div>;
  if (error) return <div className="mx-auto max-w-[1400px] p-4 sm:p-6"><BackLink canViewAll={canViewAll} /><ErrorState error={error} onRetry={refetch} /></div>;

  const asset = data.asset;
  const p = asset.permissions;
  const software = asset.kind === "software";
  const held = Boolean(asset.currentAssignment);
  const terminal = ["RETIRED", "DISPOSED"].includes(asset.status);
  const status = asset.status;

  // Lifecycle actions offered for the current state (the server re-validates every one).
  const lifecycle = [];
  if (p.canManageStatus && !asset.archived) {
    if (status === "AVAILABLE") lifecycle.push(["reserve", "Reserve"]);
    if (status === "RESERVED") lifecycle.push(["release", "Release reservation"]);
    if (!software && ["AVAILABLE", "ASSIGNED", "RESERVED"].includes(status)) lifecycle.push(["lost", "Mark as lost"]);
    if (status === "LOST") lifecycle.push(["found", "Mark as found"]);
    if (["AVAILABLE", "LOST", "UNDER_MAINTENANCE"].includes(status) && !held) lifecycle.push(["retire", "Retire"]);
    if (status === "RETIRED") lifecycle.push(["dispose", "Mark as disposed"]);
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <BackLink canViewAll={canViewAll} />
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">{software ? <KeyRound className="size-6" /> : <Laptop className="size-6" />}</span>
          <div className="min-w-0 space-y-1.5">
            <h1 className="break-words text-2xl font-bold tracking-tight text-foreground">{asset.name}</h1>
            <p className="text-sm text-muted-foreground">{asset.assetId}{asset.assetTag ? ` · ${asset.assetTag}` : ""}{asset.category ? ` · ${asset.category.name}` : ""}</p>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={status} />
              {asset.archived ? <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Archived</span> : null}
              {asset.assignedUser ? <span className="text-sm text-foreground">Held by {asset.assignedUser.name}{asset.assignedToFormerMember ? <span className="ml-2 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:text-orange-400">no longer in the organization</span> : null}</span> : null}
              {asset.assignedTeam ? <span className="text-sm text-foreground">Held by team {asset.assignedTeam.name}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {p.canAssign && !held && !software && ["AVAILABLE", "RESERVED"].includes(status) ? <Button onClick={() => setDialog({ type: "assign" })}>Assign</Button> : null}
          {software && p.canAssign && asset.license?.availableSeats > 0 && status === "AVAILABLE" ? <Button onClick={() => setDialog({ type: "assign" })}>Assign a seat</Button> : null}
          {!software && held && p.canTransfer ? <Button variant="outline" onClick={() => setDialog({ type: "transfer" })}><ArrowRightLeft className="size-4" />Transfer</Button> : null}
          {!software && held && p.canReturn ? <Button variant="outline" onClick={() => setDialog({ type: "return" })}><CornerDownLeft className="size-4" />Record return</Button> : null}
          {!software && held && canViewAll && !asset.held ? <Button variant="outline" onClick={() => setDialog({ type: "request-return" })}>Request return</Button> : null}
          {p.canReportIssue && !software ? <Button variant="outline" onClick={() => setDialog({ type: "issue" })}><Wrench className="size-4" />Report a problem</Button> : null}
          {(p.canEdit || lifecycle.length > 0 || p.canArchive) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {p.canEdit ? <DropdownMenuItem onSelect={() => setDialog({ type: "edit" })}><Pencil className="size-4" />Edit details</DropdownMenuItem> : null}
                {lifecycle.map(([name, text]) => <DropdownMenuItem key={name} onSelect={() => setDialog({ type: name })}>{text}</DropdownMenuItem>)}
                {p.canArchive ? <DropdownMenuSeparator /> : null}
                {p.canArchive && !asset.archived ? <DropdownMenuItem disabled={held || (software && asset.license?.allocatedSeats > 0)} onSelect={() => archive.mutate(asset.id)}><Archive className="size-4" />Archive</DropdownMenuItem> : null}
                {p.canArchive && asset.archived ? <DropdownMenuItem onSelect={() => restore.mutate(asset.id)}><RotateCcw className="size-4" />Restore</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      {terminal && !asset.archived ? <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">This asset is {status.toLowerCase()} and can no longer be assigned.</p> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {canViewAll ? <TabsTrigger value="history">Assignment history</TabsTrigger> : null}
          {!software ? <TabsTrigger value="maintenance">Maintenance</TabsTrigger> : null}
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {canViewAll ? <TabsTrigger value="activity">Activity</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview" className="mt-4"><OverviewTab asset={asset} onSeatAction={(type, userId) => setDialog({ type, userId })} /></TabsContent>
        {canViewAll ? <TabsContent value="history" className="mt-4"><HistoryTab asset={asset} /></TabsContent> : null}
        {!software ? <TabsContent value="maintenance" className="mt-4"><MaintenanceTab asset={asset} /></TabsContent> : null}
        <TabsContent value="documents" className="mt-4"><DocumentsTab asset={asset} /></TabsContent>
        {canViewAll ? <TabsContent value="activity" className="mt-4"><ActivityTab asset={asset} /></TabsContent> : null}
      </Tabs>

      <AssetFormDialog open={dialog.type === "edit"} onOpenChange={(next) => !next && close()} asset={asset} />
      <AssignDialog open={dialog.type === "assign" || dialog.type === "transfer"} onOpenChange={(next) => !next && close()} asset={asset} mode={dialog.type === "transfer" ? "transfer" : "assign"} fromUserId={dialog.userId} />
      <ReportIssueDialog open={dialog.type === "issue"} onOpenChange={(next) => !next && close()} asset={asset} />
      <ActionDialog
        open={!["edit", "assign", "transfer", "issue", null].includes(dialog.type)}
        onOpenChange={(next) => !next && close()}
        asset={asset}
        action={dialog.type}
        extra={dialog.userId ? { userId: dialog.userId } : {}}
      />
    </div>
  );
}

function BackLink({ canViewAll }) {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit">
      <Link href={canViewAll ? "/dashboard/assets/inventory" : "/dashboard/my-assets"}><ArrowLeft className="size-4" />{canViewAll ? "Inventory" : "My assets"}</Link>
    </Button>
  );
}
