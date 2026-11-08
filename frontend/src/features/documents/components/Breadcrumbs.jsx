"use client";

import { ChevronRight, Home } from "lucide-react";

export default function Breadcrumbs({ trail = [], onNavigate, rootLabel = "Documents" }) {
  return (
    <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Home className="size-3.5" />
        {rootLabel}
      </button>
      {trail.map((crumb, index) => {
        const isLast = index === trail.length - 1;
        return (
          <span key={crumb.id} className="inline-flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
            {isLast ? (
              <span aria-current="page" className="truncate px-1.5 py-1 font-medium text-foreground">{crumb.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(crumb.id)}
                className="truncate rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {crumb.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
