"use client";

export default function RouteLoader({ label = "Checking session..." }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_35%),linear-gradient(180deg,#0f172a_0%,#020617_100%)] px-4">
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/8 px-5 py-4 text-sm text-slate-100 shadow-2xl shadow-slate-950/40 backdrop-blur-xl">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
        <span>{label}</span>
      </div>
    </div>
  );
}
