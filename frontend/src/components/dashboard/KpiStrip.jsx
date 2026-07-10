const COLS_CLASS = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

export default function KpiStrip({ items, cols = 4 }) {
  return (
    <div
      className={`grid grid-cols-2 gap-y-3 rounded-xl border border-zinc-200/70 bg-white p-3 sm:divide-x sm:divide-zinc-100 ${COLS_CLASS[cols] ?? COLS_CLASS[4]}`}
    >
      {items.map((stat) => (
        <div key={stat.label} className="flex items-center gap-2.5 px-2.5">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${stat.accent} text-white`}>
            <stat.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold leading-tight text-zinc-900">{stat.value}</p>
            <p className="truncate text-xs text-zinc-500">{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
