"use client";

import Link from "next/link";
import { EyeOff, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { documentHref, formatLocation } from "@/features/ai/utils/citations";

/**
 * The sources of ONE reply, exactly as the server confirmed them. A source that is no longer accessible (trashed, made private,
 * access revoked) arrives as `{ n, available: false }` - we show that it existed and nothing else. No name, link or location is
 * ever filled in on the client.
 */
export default function CitationList({ citations, messageId, highlighted }) {
  if (!citations?.length) return null;
  return (
    <section aria-label="Sources" className="@container mt-3">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sources</h4>
      <ol className="grid gap-1.5 @xl:grid-cols-2">
        {citations.map((c) => {
          const href = documentHref(c);
          const place = formatLocation(c.location);
          const active = highlighted === c.n;
          return (
            <li
              key={c.n}
              id={`cite-${messageId}-${c.n}`}
              className={cn("flex items-start gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs transition-colors", active && "border-primary/50 bg-primary/5 ring-1 ring-primary/30", c.available === false && "bg-muted/40")}
            >
              <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-semibold text-primary">{c.n}</span>
              {c.available === false ? (
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><EyeOff className="size-3.5 shrink-0" />Source no longer available</span>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    {href ? (
                      <Link href={href} className="truncate font-medium text-foreground underline-offset-2 hover:underline" title={c.documentName}>{c.documentName || "Document"}</Link>
                    ) : (
                      <span className="truncate font-medium text-foreground" title={c.documentName}>{c.documentName || "Document"}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-muted-foreground">
                    {[Number.isInteger(c.version) ? `Version ${c.version}` : null, place].filter(Boolean).join(" · ")}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
