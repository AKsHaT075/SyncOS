"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { PERMISSIONS } from "@/constants/permissions";
import { useSectionBadges } from "@/features/notifications/hooks/useSectionBadges";
import { cn } from "@/lib/utils";
import { CONDITIONS, MAINTENANCE_STATUSES, STATUS_BY_VALUE } from "@/features/assets/constants/assetOptions";

export function StatusBadge({ status, className }) {
  const meta = STATUS_BY_VALUE[status] ?? { label: status, tone: "bg-muted text-muted-foreground" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", meta.tone, className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function MaintenanceBadge({ status }) {
  const meta = MAINTENANCE_STATUSES[status] ?? { label: status, tone: "bg-muted text-muted-foreground" };
  return <span className={cn("inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", meta.tone)}>{meta.label}</span>;
}

export const conditionLabel = (value) => CONDITIONS.find((condition) => condition.value === value)?.label ?? value;

/** Label + control + error, wired for accessibility. */
export function Field({ label, htmlFor, error, hint, children, className }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

export const selectClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export function NativeSelect({ id, children, className, ...props }) {
  return (
    <select id={id} className={cn(selectClass, className)} {...props}>
      {children}
    </select>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({ title, description, action, children, className }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs sm:p-5", className)}>
      {title || action ? (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center">
      {Icon ? <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-5" /></span> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const status = error?.response?.status;
  const message = status === 404 ? "This item doesn't exist, or you don't have access to it." : status === 403 ? "You don't have permission to see this." : "Something went wrong while loading this.";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-4 py-12 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="text-sm text-foreground">{message}</p>
      {status !== 404 && status !== 403 && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-lg" />)}
    </div>
  );
}

export function Pager({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-3 pt-3 text-xs text-muted-foreground" aria-label="Pagination">
      <span>Page {pagination.page} of {pagination.pages} · {pagination.total} total</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}><ChevronLeft className="size-4" />Previous</Button>
        <Button variant="outline" size="sm" disabled={pagination.page >= pagination.pages} onClick={() => onPage(pagination.page + 1)}>Next<ChevronRight className="size-4" /></Button>
      </div>
    </nav>
  );
}

export function SubmitButton({ pending, children, ...props }) {
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </Button>
  );
}

const TABS = [
  { label: "Overview", href: "/dashboard/assets", permission: PERMISSIONS.VIEW_ASSETS, exact: true },
  { label: "Inventory", href: "/dashboard/assets/inventory", permission: PERMISSIONS.VIEW_ASSETS },
  { label: "Assignments", href: "/dashboard/assets/assignments", permission: PERMISSIONS.VIEW_ASSETS },
  { label: "Maintenance", href: "/dashboard/assets/maintenance", permission: PERMISSIONS.VIEW_ASSETS },
  { label: "Catalog", href: "/dashboard/assets/catalog", permission: PERMISSIONS.VIEW_ASSETS },
];

function TabLink({ tab, pathname }) {
  const allowed = usePermission(tab.permission);
  const { badgeFor } = useSectionBadges();
  const badge = badgeFor(tab.href, { exact: true });
  if (!allowed) return null;
  const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors", active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
    >
      {tab.label}
      {badge > 0 ? (
        <span aria-label={`${badge} unread notification${badge === 1 ? "" : "s"}`} className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

export function AssetsSubNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Assets sections" className="-mx-1 overflow-x-auto border-b border-border">
      <div className="flex min-w-max px-1">{TABS.map((tab) => <TabLink key={tab.href} tab={tab} pathname={pathname} />)}</div>
    </nav>
  );
}

/** Page-level guard: the server enforces access too; this just avoids showing a broken screen. */
export function RequirePermission({ permission, children }) {
  const allowed = usePermission(permission);
  if (allowed) return children;
  return (
    <div role="alert" className="mx-auto max-w-md p-10 text-center">
      <p className="text-sm font-medium text-foreground">You don&apos;t have access to this page.</p>
      <p className="mt-1 text-xs text-muted-foreground">Ask an administrator if you think this is a mistake.</p>
    </div>
  );
}
