"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowUp, Languages, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { UNSUPPORTED_LANGUAGE_HINT, isSupportedLanguage } from "@/features/ai/utils/language";

export const MAX_QUESTION_CHARS = 2000; // matches the server's AI_RAG_MAX_QUESTION_CHARS default; the server remains the authority

/**
 * The message box. Enter sends, Shift+Enter adds a line, and Enter during IME composition is left alone. A question in an
 * unsupported script is NOT sent: the user is told why and can edit it. While a reply is arriving the button becomes "Stop".
 * The draft lives in component state only (never in browser storage).
 */
export default function Composer({ value, onChange, onSend, onStop, busy, disabled, disabledReason, autoFocusKey }) {
  const ref = useRef(null);
  const trimmed = value.trim();
  const unsupported = useMemo(() => trimmed.length > 0 && !isSupportedLanguage(trimmed), [trimmed]);
  const tooLong = value.length > MAX_QUESTION_CHARS;
  const canSend = !disabled && !busy && trimmed.length > 0 && !unsupported && !tooLong;

  useEffect(() => {
    ref.current?.focus();
  }, [autoFocusKey]);

  const submit = () => {
    if (canSend) onSend();
  };

  return (
    <div className="border-t border-border bg-background px-3 pb-3 pt-2 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {unsupported ? (
          <p role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <Languages className="mt-px size-3.5 shrink-0" />
            {UNSUPPORTED_LANGUAGE_HINT}
          </p>
        ) : null}
        {disabled && disabledReason ? <p className="mb-2 text-xs text-muted-foreground">{disabledReason}</p> : null}

        <div className={cn("flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-xs transition-colors focus-within:ring-3", unsupported || tooLong ? "border-destructive/60 focus-within:border-destructive focus-within:ring-destructive/20" : "border-input focus-within:border-ring focus-within:ring-ring/40", disabled && "opacity-70")}>
          <Textarea
            ref={ref}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask about your company's documents…"
            aria-label="Message"
            aria-invalid={unsupported || tooLong}
            disabled={disabled}
            className="max-h-48 min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 dark:bg-transparent dark:aria-invalid:border-0 dark:aria-invalid:ring-0"
          />
          {busy ? (
            <Button type="button" size="icon" variant="outline" onClick={onStop} aria-label="Stop generating" className="rounded-xl">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="button" size="icon" onClick={submit} disabled={!canSend} aria-label="Send message" className="rounded-xl">
              <ArrowUp />
            </Button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
          <span>Answers come only from documents you can access, with sources. English only.</span>
          <span className={cn(tooLong && "font-medium text-destructive", value.length < MAX_QUESTION_CHARS * 0.75 && "sr-only")}>{value.length}/{MAX_QUESTION_CHARS}</span>
        </div>
      </div>
    </div>
  );
}
