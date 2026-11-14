"use client";

import { Fragment } from "react";
import { cn } from "@/lib/utils";
import CodeBlock from "@/features/ai/components/CodeBlock";
import { parseBlocks } from "@/features/ai/utils/markdown";

/**
 * Renders model output. It builds React elements from a parsed tree - there is NO raw HTML path (no dangerouslySetInnerHTML), so
 * markup in a reply or in a quoted document is just text. Links are limited to http(s)/mailto by the parser.
 *
 * `[n]` markers become buttons ONLY when the message really has that source; a marker for a missing source stays plain text, and
 * one whose source is no longer available is shown muted and inert.
 */
function Cite({ n, citations, messageId, onCite }) {
  const citation = citations.find((c) => c.n === n);
  if (!citation) return <span>[{n}]</span>;
  if (citation.available === false) {
    return (
      <span title="Source no longer available" className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 align-baseline text-[10px] font-medium text-muted-foreground line-through">
        {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onCite?.(messageId, n)}
      title={`Go to source ${n}${citation.documentName ? `: ${citation.documentName}` : ""}`}
      aria-label={`Source ${n}`}
      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/10 px-1 align-baseline text-[10px] font-semibold text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {n}
    </button>
  );
}

function Inline({ nodes, ctx }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>;
      case "strong":
        return <strong key={index} className="font-semibold"><Inline nodes={node.children} ctx={ctx} /></strong>;
      case "em":
        return <em key={index}><Inline nodes={node.children} ctx={ctx} /></em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-primary underline underline-offset-2 hover:opacity-80">
            <Inline nodes={node.children} ctx={ctx} />
          </a>
        );
      case "cite":
        return <Cite key={index} n={node.n} {...ctx} />;
      default:
        return null;
    }
  });
}

function Blocks({ blocks, ctx }) {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const sizes = ["text-lg", "text-base", "text-[15px]", "text-sm", "text-sm", "text-sm"];
        return <p key={index} role="heading" aria-level={Math.min(block.level + 2, 6)} className={cn("mt-4 mb-1.5 font-semibold text-foreground first:mt-0", sizes[block.level - 1])}><Inline nodes={block.children} ctx={ctx} /></p>;
      }
      case "paragraph":
        return <p key={index} className="my-2 whitespace-pre-line leading-relaxed first:mt-0 last:mb-0"><Inline nodes={block.children} ctx={ctx} /></p>;
      case "code":
        return <CodeBlock key={index} code={block.text} lang={block.lang} />;
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          <List key={index} start={block.ordered ? block.start : undefined} className={cn("my-2 space-y-1 pl-5 leading-relaxed", block.ordered ? "list-decimal" : "list-disc")}>
            {block.items.map((item, i) => (
              <li key={i} className="pl-0.5">
                <Inline nodes={item.children} ctx={ctx} />
                {item.sub ? <Blocks blocks={item.sub} ctx={ctx} /> : null}
              </li>
            ))}
          </List>
        );
      }
      case "blockquote":
        return <blockquote key={index} className="my-2 border-l-2 border-border pl-3 text-muted-foreground"><Blocks blocks={block.children} ctx={ctx} /></blockquote>;
      case "hr":
        return <hr key={index} className="my-4 border-border" />;
      case "table":
        return (
          <div key={index} className="my-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/60">
                <tr>{block.header.map((cell, i) => <th key={i} style={{ textAlign: block.align[i] }} className="border-b border-border px-3 py-1.5 font-medium"><Inline nodes={cell} ctx={ctx} /></th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-b border-border last:border-0">
                    {row.map((cell, i) => <td key={i} style={{ textAlign: block.align[i] }} className="px-3 py-1.5 align-top"><Inline nodes={cell} ctx={ctx} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  });
}

export default function Markdown({ text, citations = [], messageId, onCite, className }) {
  const blocks = parseBlocks(text);
  return (
    <div className={cn("break-words text-sm text-foreground", className)}>
      <Blocks blocks={blocks} ctx={{ citations, messageId, onCite }} />
    </div>
  );
}
