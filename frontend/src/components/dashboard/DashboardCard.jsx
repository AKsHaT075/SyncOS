import PreviewBadge from "@/components/dashboard/PreviewBadge";

export function DashboardCard({ className = "", children }) {
  return <div className={`rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

export function DashboardCardHeader({ icon: Icon, iconClassName = "bg-violet-50 text-violet-600", title, description, action, preview = false }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}>
            <Icon className="size-5" />
          </span>
        )}
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">{title}{preview ? <PreviewBadge /> : null}</h2>
          {description && <p className="text-xs text-zinc-500">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
