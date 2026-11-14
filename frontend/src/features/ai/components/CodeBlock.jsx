"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea"); // very old / non-secure-context fallback
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    document.body.removeChild(area);
  }
  return undefined;
}

/** Fenced code: language label, horizontal scroll (never wraps the page) and a copy button with a clear confirmation. */
export default function CodeBlock({ code, lang }) {
  const [state, setState] = useState("idle"); // idle | copied | failed
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await writeClipboard(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border bg-muted/60 px-3 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{lang || "text"}</span>
        <Button type="button" variant="ghost" size="xs" onClick={copy} aria-label={state === "copied" ? "Copied" : "Copy code"}>
          {state === "copied" ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
          <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-foreground" tabIndex={0}>
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
