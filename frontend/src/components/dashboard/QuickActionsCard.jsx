export default function QuickActionsCard({ actions, size = "default" }) {
  const compact = size === "sm";

  return (
    <div className={compact ? "flex flex-wrap gap-2" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-4"}>
      {actions.map((action) => {
        const content = compact ? (
          <>
            <action.icon className="size-3.5" />
            {action.label}
          </>
        ) : (
          <>
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${action.accent} text-white shadow-sm`}
            >
              <action.icon className="size-5" />
            </span>
            <span className="text-sm font-medium text-zinc-700 group-hover:text-zinc-900">{action.label}</span>
          </>
        );

        const className = compact
          ? "flex items-center gap-1.5 rounded-lg border border-zinc-200/70 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50"
          : "group flex items-center gap-3 rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md";

        if (action.onClick) {
          return (
            <button key={action.label} type="button" onClick={action.onClick} className={className}>
              {content}
            </button>
          );
        }

        return (
          <a key={action.label} href={action.href} className={className}>
            {content}
          </a>
        );
      })}
    </div>
  );
}
