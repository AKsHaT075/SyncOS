export default function PreviewBadge({ children = "Preview · Coming soon" }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </span>
  );
}
