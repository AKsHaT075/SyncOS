export default function KpiRow({ items }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((stat) => (
        <div
          key={stat.label}
          className="group relative overflow-hidden rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg"
        >
          <div
            className={`absolute -top-8 -right-8 size-28 rounded-full bg-gradient-to-br ${stat.accent} opacity-[0.07] transition-opacity group-hover:opacity-[0.12]`}
          />
          <span
            className={`flex size-10 items-center justify-center rounded-xl bg-gradient-to-br ${stat.accent} text-white shadow-md`}
          >
            <stat.icon className="size-5" />
          </span>
          <p className="mt-4 text-2xl font-bold tracking-tight text-zinc-900">{stat.value}</p>
          <p className="text-sm text-zinc-500">{stat.label}</p>
        </div>
      ))}
    </div>
  );
}
