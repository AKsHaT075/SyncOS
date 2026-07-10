export default function EmptyStateCard({ icon: Icon, title, description }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      {Icon && (
        <span className="flex size-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
          <Icon className="size-4.5" />
        </span>
      )}
      <p className="text-sm font-medium text-zinc-700">{title}</p>
      {description && <p className="text-xs text-zinc-500">{description}</p>}
    </div>
  );
}
