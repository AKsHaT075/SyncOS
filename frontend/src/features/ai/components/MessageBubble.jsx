"use client";

import { memo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Check, CircleSlash, Copy, Languages, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import CitationList from "@/features/ai/components/CitationList";
import Markdown from "@/features/ai/components/Markdown";
import { normalizeCitations } from "@/features/ai/utils/citations";
import { describeAiError } from "@/features/ai/utils/errors";

function Notice({ tone = "muted", icon: Icon, children, action }) {
  const tones = {
    muted: "border-border bg-muted/40 text-muted-foreground",
    warn: "border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
    error: "border-destructive/30 bg-destructive/5 text-destructive",
  };
  return (
    <div role={tone === "error" ? "alert" : "note"} className={cn("mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs", tones[tone])}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy reply"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable: nothing to do */
        }
      }}
    >
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
    </Button>
  );
}

function TypingDots({ label }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
      <span className="flex shrink-0 gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 160}ms` }} />)}
      </span>
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
}

function UserBubble({ message }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] sm:max-w-[75%]">
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">{message.content}</div>
        {message.createdAt ? <p className="mt-1 pr-1 text-right text-[10px] text-muted-foreground">{format(new Date(message.createdAt), "p")}</p> : null}
      </div>
    </div>
  );
}

/**
 * One assistant reply. `live` = it is still arriving (an overlay from the stream, not yet re-read from the server).
 * status: streaming | complete | incomplete | error  (the server's, or "streaming" for the live overlay)
 */
function AssistantBubble({ message, live, phase, sourcesUsed, activity, previousUserText, onAskAgain, onCite, highlighted }) {
  const citations = normalizeCitations(message.citations);
  const text = message.content || "";
  const status = message.status;
  const finishing = live && phase === "stopping";
  const empty = !text.trim();

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true"><Sparkles className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        {empty && (live || status === "streaming") ? (
          <TypingDots label={finishing ? "Stopping…" : activity ? `${activity}…` : sourcesUsed == null ? "Searching your documents…" : "Writing the answer…"} />
        ) : message.finishReason === "unsupported_language" ? (
          <Notice tone="warn" icon={Languages}>{text}</Notice>
        ) : empty ? null : (
          <Markdown text={text} citations={citations} messageId={message.id} onCite={onCite} />
        )}

        {live && !empty && !finishing ? <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/50 align-middle" aria-hidden="true" /> : null}

        {status === "incomplete" && !live ? (
          <Notice tone="warn" icon={CircleSlash} action={previousUserText ? <Button type="button" size="xs" variant="outline" onClick={() => onAskAgain(previousUserText)}><RotateCcw />Ask again</Button> : null}>
            {message.finishReason === "cancelled" ? "This reply was stopped before it finished." : message.finishReason === "interrupted" ? "This reply was interrupted and is incomplete." : describeAiError({ code: message.errorCode, status: 502 })}
          </Notice>
        ) : null}
        {status === "error" && !live ? (
          <Notice tone="error" icon={AlertTriangle} action={previousUserText ? <Button type="button" size="xs" variant="outline" onClick={() => onAskAgain(previousUserText)}><RotateCcw />Ask again</Button> : null}>
            {describeAiError({ code: message.errorCode, status: 502 })}
          </Notice>
        ) : null}
        {message.finishReason === "no_context" && !live ? <Notice icon={CircleSlash}>No matching documents that you have access to were found.</Notice> : null}

        <CitationList citations={citations} messageId={message.id} highlighted={highlighted} />

        {!live && status !== "streaming" && text ? (
          <div className="mt-1.5 flex items-center gap-1 text-muted-foreground">
            <CopyButton text={text} />
            {message.createdAt ? <span className="text-[10px]">{format(new Date(message.createdAt), "p")}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageBubble(props) {
  return props.message.role === "user" ? <UserBubble {...props} /> : <AssistantBubble {...props} />;
}

export default memo(MessageBubble);
